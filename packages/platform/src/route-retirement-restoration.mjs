import { isDeepStrictEqual } from 'node:util';
import { runtimePolicyIdentity, validateRuntimePolicy } from './runtime-policy.mjs';
import { overlap, retirementApp, retireState } from './retirement.mjs';
import { validateRouteSnapshot } from './route-snapshot.mjs';
import { retireRouteAuthority } from './route-retirement.mjs';
import { routeRecordDigest } from './route-record-store.mjs';
import { prepareRouteRestoration, restorationBackgrounds, routePolicy } from './route-restoration-plan.mjs';

const refused = () => Object.assign(new Error('Route retirement requires an exact approved source and a fresh replacement fleet; keep ingress stopped and retain all stores'), { code: 'ROUTE_RETIREMENT_REFUSED' });
const exact = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...names].sort());
const withoutNetworks = ({ networks, ...policy }) => policy;

function retirementEvidence(input, source, target) {
  const { app, digest, evidence, stopQueuedWork, stopScheduledWork } = input.retirement;
  if (typeof stopQueuedWork !== 'boolean' || typeof stopScheduledWork !== 'boolean' ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(evidence?.id) ||
    typeof evidence.at !== 'string' || new Date(evidence.at).toISOString() !== evidence.at) throw refused();
  const assigned = retirementApp(input.source.state, app, digest, { stopQueuedWork, stopScheduledWork });
  const fleet = source.fleets.find(value => value.id === assigned.slot);
  if (!fleet) throw refused();
  const prefix = `retirement-generations/${evidence.id}`, nodes = fleet.nodes.map(node => `${node.host}-${evidence.id}`);
  const retained = [...source.fleets.map(value => value.prefix), ...Object.values(input.source.state.apps).filter(value => value.retirement).map(value => value.retirement.previous.prefix)];
  if (retained.some(value => overlap(value, prefix))) throw refused();
  const expected = structuredClone(source), replacement = expected.fleets.find(value => value.id === fleet.id);
  replacement.prefix = prefix;
  for (const [index, node] of replacement.nodes.entries()) node.id = nodes[index];
  if (!isDeepStrictEqual(withoutNetworks(expected), withoutNetworks(target))) throw refused();
  const checked = { id: evidence.id, at: evidence.at, app, digest, snapshot: { sha256: input.snapshot },
    previous: { slot: fleet.id, prefix: fleet.prefix, nodes: fleet.nodes.map(node => node.id) }, replacement: { prefix, nodes },
    runtimeSelection: { family: source.family, sourceIdentitySha256: runtimePolicyIdentity(source), targetIdentitySha256: runtimePolicyIdentity(target) } };
  if (!isDeepStrictEqual(evidence, checked)) throw refused();
  return checked;
}

// The request carries the original verified snapshot pair, never a caller-supplied
// transformed source. This projects retirement first, then applies the ordinary
// withheld-restoration rules to that internally derived pair. Archive verification,
// stopped writers and fresh enrollment remain the host coordinator's obligations.
export function prepareRetiredRouteRestoration(input) {
  try {
    if (!exact(input, ['profile', 'sourceProfile', 'source', 'snapshot', 'binding', 'domain', 'retirement']) ||
      !exact(input.source, ['state', 'authority']) || !exact(input.retirement, ['app', 'digest', 'evidence', 'stopQueuedWork', 'stopScheduledWork'])) throw refused();
    const source = validateRuntimePolicy(input.sourceProfile), target = validateRuntimePolicy(input.profile);
    validateRouteSnapshot(input.source.state, input.source.authority, source, input.domain);
    // Check every live app's original background receipt before retiring one.
    restorationBackgrounds(input.source.state);
    const evidence = retirementEvidence(input, source, target);
    const state = retireState(input.source.state, input.retirement.app, input.retirement.digest, evidence, input.retirement);
    const retired = retireRouteAuthority(state, input.source.authority, { app: input.retirement.app, domain: input.domain,
      sourcePolicy: routePolicy(source), targetPolicy: routePolicy(target) });
    const authority = { record: retired.record, digest: routeRecordDigest(retired.record, routePolicy(target)) };
    return prepareRouteRestoration({ profile: target, sourceProfile: target, source: { state: retired.state, authority },
      snapshot: input.snapshot, binding: input.binding, domain: input.domain });
  } catch { throw refused(); }
}
