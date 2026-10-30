import { isDeepStrictEqual } from 'node:util';
import { artifactDigest } from '@fogd/runtime/artifact';

export const claimCapability = 'fogd-claim-intent-v1';
export function reserveClaim(state, request, slot, privateConfiguration) {
  state.requirements = [...new Set([...(state.requirements || []), claimCapability])];
  const app = { slot: slot.id, resources: structuredClone(request.resources), migrations: [], active: null, route: 'paused', uncertain: null, privateConfiguration,
    claim: { deployment: request.id, digest: request.digest, prefix: slot.prefix } };
  state.apps[request.app] = app;
  return app;
}
export async function inspectOwnership(controller) {
  for (const slot of controller.slots) await observeOwner(controller, slot);
  for (const [name, app] of Object.entries(controller.state.apps)) {
    if (!app.retirement && !app.archive) await verifyOwner(controller, name, app);
  }
}
async function observeOwner(c, slot) {
  const owner = await c.backend.owner(slot);
  if (!owner) return;
  c.occupied.add(slot.id); c.bucketOwners.set(slot.id, owner.app);
  const app = c.state.apps[owner.app];
  if (app?.archive) throw new Error('Archived app owns a configured fleet; restore matching storage identities');
  if (app?.retirement) throw new Error('Retired app owns a configured fleet; restore matching configuration and metadata');
  if (!app) {
    c.state.apps[owner.app] = { slot: slot.id, route: 'paused' };
    quarantine(c.state.apps[owner.app], 'Bucket owner has no controller record; restore controller backup');
  } else if (app.slot !== slot.id) quarantine(app, 'Multiple bucket slots claim this app; reconcile bucket and controller backups');
}
async function verifyOwner(c, name, app) {
  const slot = c.slots.find(s => s.id === app.slot);
  const owner = slot ? await c.backend.owner(slot) : null;
  const pending = app.claim ? await validClaim(c, name, app, slot) : false;
  if (pending && await c.backend.hasDeployment(slot)) return quarantine(app, 'Pending ownership claim contains deployment objects; restore matching metadata');
  if (app.claim && !pending) return quarantine(app, 'Pending ownership intent does not match approved artifact or configured fleet');
  if (!slot || (owner ? owner.app !== name : !pending)) quarantine(app, 'Configured slot or bucket owner is missing/mismatched; restore matching bucket, config, and controller backups');
}
async function validClaim(c, name, app, slot) {
  if (!c.state.requirements?.includes(claimCapability) || !slot || app.claim.prefix !== slot.prefix) return false;
  const request = claimApproval(c.state, name, app);
  if (!request) return false;
  try { return await artifactDigest(c.artifact(request.id)) === app.claim.digest; }
  catch { return false; }
}
function claimApproval(state, name, app) {
  const intent = app.claim;
  if (typeof intent.deployment !== 'string' || typeof intent.digest !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(intent.deployment) || !/^[a-f0-9]{64}$/.test(intent.digest)) return null;
  const request = state.deployments[intent.deployment];
  if (!request || request.app !== name || request.id !== intent.deployment || request.digest !== intent.digest) return null;
  if (!['activating', 'failed'].includes(request.status) || request.step !== 'preparing-activation' || !Object.hasOwn(request, 'secretRevision')) return null;
  return initialReservation(app, request) ? request : null;
}
function initialReservation(app, request) {
  return app.active === null && app.uncertain === null && app.route === 'paused' && app.migrations?.length === 0 &&
    app.privateConfiguration === Boolean(request.secretRevision) && isDeepStrictEqual(request.resources, app.resources);
}
function quarantine(app, reason) { app.quarantined = true; app.route = 'paused'; app.reason = reason; }

export function assertClaimRequest(state, request) {
  for (const [name, app] of Object.entries(state.apps)) {
    if (app.claim?.deployment === request.id && name !== request.app) throw new Error('Ownership approval app mismatch; restore matching controller state');
  }
}
export async function rejectUnclaimed(c, request) {
  const app = c.state.apps[request.app];
  if (!app?.claim || app.claim.deployment !== request.id) return;
  const slot = c.slots.find(s => s.id === app.slot);
  if (!slot || slot.prefix !== app.claim.prefix) throw new Error('Restore the claim fleet configuration before rejecting its reservation');
  if (app.active !== null || app.uncertain !== null || app.migrations?.length !== 0) throw new Error('Ownership reservation is not pristine; restore matching controller state');
  for (const other of c.slots) {
    if (other.id !== slot.id && (await c.backend.owner(other))?.app === request.app) throw new Error('Another fleet owns this app; restore matching ownership metadata before rejection');
  }
  await c.backend.assertUnclaimed(slot);
  await c.routes.releaseClaim(request);
  // The caller persists reservation removal and rejection together. No bucket
  // objects are deleted, and an ambiguous local write trips the shared latch.
  request.claimRelease = { schema: 1, deployment: request.id, digest: request.digest, slot: slot.id, prefix: slot.prefix, at: new Date(c.clock()).toISOString() };
  delete c.state.apps[request.app];
  c.occupied.delete(slot.id); c.bucketOwners.delete(slot.id);
}
