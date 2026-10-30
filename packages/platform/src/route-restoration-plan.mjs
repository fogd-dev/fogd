import { isDeepStrictEqual } from 'node:util';
import { encodeRouteRecord } from '@fogd/runtime/route-record';
import { completedRoute } from './route-publication.mjs';
import { routeRecordDigest } from './route-record-store.mjs';
import { validateRouteSnapshot } from './route-snapshot.mjs';
import { hasDurableRuntimeMode, runtimePolicyIdentity, validateRuntimePolicy } from './runtime-policy.mjs';
import { restorationBackgrounds, restoreBackgrounds } from './background-restoration.mjs';
export { restorationBackgrounds } from './background-restoration.mjs';

const refused = () => Object.assign(new Error('Route restoration requires a verified source and matching durable profiles; keep ingress stopped and retain all stores'), { code: 'ROUTE_RESTORATION_REFUSED' });
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keys = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

function durable(profile) {
  const policy = validateRuntimePolicy(profile);
  if (!hasDurableRuntimeMode(policy)) throw refused();
  return policy;
}
const withoutNetworks = ({ networks, ...policy }) => policy;
export function routePolicy(profile) {
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
  const recovered = restorationBackgrounds(source);
  const holds = { ...source.routeAuthority.holds };
  for (const route of observed.record.routes) {
    if (route.state !== 'active') continue;
    const name = route.host.slice(0, -(domain.length + 1)), selected = completedRoute(source, name, domain);
    holds[name] = { id: selected.submission, digest: selected.digest };
  }
  const state = structuredClone(source);
  restoreBackgrounds(state, recovered, snapshot);
  for (const app of Object.values(state.apps)) if (!app.retirement) app.route = 'paused';
  delete state.routeEnrollment;
  const record = { schema: 1, installation: policy.installation, revision: '1', routes: observed.record.routes.map(({ host, slot }) => ({ host, state: 'withheld', slot })) };
  const digest = routeRecordDigest(record, policy);
  state.routeAuthority = { schema: 1, installation: policy.installation, holds, settled: { revision: '1', digest }, pending: null };
  validateRouteSnapshot(state, { record, digest }, profile, domain);
  return { state, record };
}

