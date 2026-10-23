import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { encodeRouteRecord, routeRecordFilename } from '@fogd/runtime/route-record';
import { spendRouteRestoration } from './route-enrollment.mjs';
import { completedRoute, routeAuthorityCapability } from './route-publication.mjs';
import { readRouteRecord, routeRecordDigest, writeRouteRecord } from './route-record-store.mjs';
import { validateRouteSnapshot } from './route-snapshot.mjs';
import { runtimePolicyIdentity, validateRuntimePolicy } from './runtime-policy.mjs';
import { writeAtomicFile } from './atomic-file.mjs';
import { hasQueueLifecycle } from './queue-history.mjs';
import { hasCronLifecycle } from './cron-history.mjs';
import { assertSnapshotAge, matchingSnapshot, queueRecoveryCapability } from './queue-snapshot.mjs';
import { cronRecoveryCapability, matchingCronSnapshot } from './cron-snapshot.mjs';

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const refused = () => Object.assign(new Error('Route restoration requires a verified source, matching durable profiles and an exactly fresh enrolled target; keep ingress stopped and retain all stores'), { code: 'ROUTE_RESTORATION_REFUSED' });
const uncertain = () => Object.assign(new Error('Route restoration is uncertain after spending its marker; keep ingress stopped, retain all stores and require independent repair or a fresh target'), { code: 'ROUTE_RESTORATION_UNCERTAIN' });
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
function routePolicy(profile) {
  return { installation: runtimePolicyIdentity(profile), slots: profile.fleets.map(fleet => fleet.id) };
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
  const now = Date.now(), recovered = [];
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

async function privateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_STATE_BYTES) throw refused();
    const buffer = Buffer.alloc(stat.size), { bytesRead } = await file.read(buffer, 0, stat.size, 0);
    if (bytesRead !== stat.size) throw refused();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } finally { await file.close(); }
}
// Only the exact stores written by initializeFreshRouteStores qualify. Restored
// controller data files may sit beside state.json; nothing else may differ.
async function assertFreshlyInitialized({ installation, targets }, policy) {
  const record = { schema: 1, installation, revision: '0', routes: [] }, digest = routeRecordDigest(record, policy);
  if (!isDeepStrictEqual(await readdir(targets.authority.path), [routeRecordFilename])) throw refused();
  const observed = await readRouteRecord(join(targets.authority.path, routeRecordFilename), policy);
  if (observed?.digest !== digest || !isDeepStrictEqual(observed.record, record)) throw refused();
  const expected = { apps: {}, deployments: {}, routeEnrollment: { controller: targets.controller, authority: targets.authority }, requirements: [routeAuthorityCapability],
    routeAuthority: { schema: 1, installation, holds: {}, settled: { revision: '0', digest }, pending: null } };
  if (!isDeepStrictEqual(await privateJson(join(targets.controller.path, 'state.json')), expected)) throw refused();
}

// Dedicated stopped finalizer, after the coordinator has independently
// authorized both profiles, verified the archive bytes, allocated fresh stopped
// target resources, installed execution policies, completed ordinary fresh route
// enrollment, restored controller data files without touching state.json, and
// confirmed every copy helper terminal. None of that is provable here. It never
// initializes a retained controller, starts a backend, listener or secret
// materialization. Host enrollment stays pending throughout, so an interrupted
// mismatch remains fenced for independent repair, never journal replay.
// Paths and the publisher are trusted options, never taken from input JSON.
export async function restoreEnrolledRouteStores(input, { controller = '/var/lib/fogd', authority = '/var/lib/fogd-routes', enrollment = '/var/lib/fogd-enrollment', writePrivate = writeAtomicFile, writePublic = writeRouteRecord } = {}) {
  let projected, policy, grant;
  try {
    if (typeof writePrivate !== 'function' || typeof writePublic !== 'function' || ![controller, authority, enrollment].every(path => typeof path === 'string' && isAbsolute(path))) throw refused();
    projected = prepareRouteRestoration(input); policy = routePolicy(input.profile);
    grant = await spendRouteRestoration({ profile: input.profile, binding: input.binding, snapshot: input.snapshot, controller, authority, enrollment }, target => assertFreshlyInitialized(target, policy));
  } catch (error) { throw error.code === 'ROUTE_ENROLLMENT_UNCERTAIN' ? uncertain() : refused(); }
  try {
    const statePath = join(grant.targets.controller.path, 'state.json'), recordPath = join(grant.targets.authority.path, routeRecordFilename);
    const state = { ...projected.state, routeEnrollment: { controller: grant.targets.controller, authority: grant.targets.authority } };
    await writePrivate(statePath, JSON.stringify(state, null, 2), { createDirectory: false });
    await writePublic(recordPath, projected.record, policy);
    const saved = await privateJson(statePath), observed = await readRouteRecord(recordPath, policy);
    if (!isDeepStrictEqual(saved, state) || observed?.digest !== state.routeAuthority.settled.digest || !isDeepStrictEqual(observed.record, projected.record)) throw uncertain();
    return { id: grant.id, installation: grant.installation, binding: grant.binding, snapshot: input.snapshot, revision: '1', sha256: observed.digest };
  } catch { throw uncertain(); }
}
