import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { encodeRouteRecord } from '@fogd/runtime/route-record';
import { completedRoute } from './route-publication.mjs';
import { routeRecordDigest } from './route-record-store.mjs';
import { validateRouteSnapshot } from './route-snapshot.mjs';
import { runtimePolicyIdentity, validateRuntimePolicy } from './runtime-policy.mjs';
import { hasQueueLifecycle } from './queue-history.mjs';
import { hasCronLifecycle } from './cron-history.mjs';
import { assertSnapshotAge, matchingSnapshot, queueRecoveryCapability } from './queue-snapshot.mjs';
import { cronRecoveryCapability, matchingCronSnapshot } from './cron-snapshot.mjs';

const refused = () => Object.assign(new Error('Route restoration requires a verified source and matching durable profiles; keep ingress stopped and retain all stores'), { code: 'ROUTE_RESTORATION_REFUSED' });
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
// Same protocol fields as the CLI background restore.
const families = [
  { recovery: 'queueRecovery', field: 'queueSnapshot', capability: queueRecoveryCapability, lifecycle: hasQueueLifecycle, match: matchingSnapshot, check: assertSnapshotAge },
  { recovery: 'cronRecovery', field: 'cronSnapshot', capability: cronRecoveryCapability, lifecycle: hasCronLifecycle, match: matchingCronSnapshot },
];

function durable(profile) {
  const policy = validateRuntimePolicy(profile);
  if (policy.schema !== 3 || policy.routing !== 'durable') throw refused();
  return policy;
}
const withoutNetworks = ({ networks, ...policy }) => policy;
export function routePolicy(profile) {
  return { installation: runtimePolicyIdentity(profile), slots: profile.fleets.map(fleet => fleet.id) };
}

export function restorationBackgrounds(source, now = Date.now()) {
  const recovered = [];
  for (const [name, app] of Object.entries(source.apps)) {
    if (app.retirement) continue;
    for (const family of families) {
      if (!family.lifecycle(app)) continue;
      if (app[family.recovery] && app[family.recovery].status !== 'acknowledged') throw refused();
      const receipt = app[family.field];
      if (!receipt) throw refused();
      family.match(source, name, receipt); family.check?.(receipt, now);
      recovered.push([name, family]);
    }
  }
  return recovered;
}

// Pure projection of a verified source pair onto a fresh target. It proves only
// internal consistency; archive bytes, target authorization and stopped native
// runtimes remain the restore coordinator's preconditions.
export function prepareRouteRestoration(input) {
  try { return project(input); } catch { throw refused(); }
}
function project(input) {
  if (!keys(input, ['profile', 'sourceProfile', 'source', 'snapshot', 'binding', 'domain']) || !keys(input.source, ['state', 'authority']) ||
    !hex(input.snapshot) || !hex(input.binding) || typeof input.domain !== 'string') throw refused();
  const profile = durable(input.profile), sourceProfile = durable(input.sourceProfile), { domain, snapshot } = input;
  if (!isDeepStrictEqual(withoutNetworks(profile), withoutNetworks(sourceProfile))) throw refused();
  const policy = routePolicy(profile);
  encodeRouteRecord({ schema: 1, installation: policy.installation, revision: '1', routes: [{ host: `probe.${domain}`, state: 'withheld', slot: policy.slots[0] }] }, policy);
  const source = input.source.state, observed = input.source.authority;
  validateRouteSnapshot(source, observed, sourceProfile, domain);
  // Snapshot matching requires the source's active routing, so every receipt
  // is checked against the unmodified source before anything is paused.
  const recovered = restorationBackgrounds(source);
  const holds = { ...source.routeAuthority.holds };
  for (const route of observed.record.routes) {
    if (route.state !== 'active') continue;
    const name = route.host.slice(0, -(domain.length + 1)), selected = completedRoute(source, name, domain);
    holds[name] = { id: selected.submission, digest: selected.digest };
  }
  const state = structuredClone(source);
  for (const [name, family] of recovered) {
    const app = state.apps[name];
    state.requirements = [...new Set([...state.requirements, family.capability])];
    app[family.recovery] = { id: randomUUID(), status: 'pending', snapshot, prepared: app[family.field], previous: app[family.recovery] || null };
    delete app[family.field];
  }
  for (const app of Object.values(state.apps)) if (!app.retirement) app.route = 'paused';
  delete state.routeEnrollment;
  const record = { schema: 1, installation: policy.installation, revision: '1', routes: observed.record.routes.map(({ host, slot }) => ({ host, state: 'withheld', slot })) };
  const digest = routeRecordDigest(record, policy);
  state.routeAuthority = { schema: 1, installation: policy.installation, holds, settled: { revision: '1', digest }, pending: null };
  validateRouteSnapshot(state, { record, digest }, profile, domain);
  return { state, record };
}

