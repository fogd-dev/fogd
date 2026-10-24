import { routeAuthorityCapability } from '@fogd/platform/route-snapshot';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { supportedController, object } from '../controller-schema.mjs';

const fields = ['holds', 'installation', 'pending', 'schema', 'settled'];
function journalEnvelope(value, policy) {
  if (!object(value) || Object.keys(value).sort().join() !== fields.join()) return false;
  return value.schema === 1 && value.installation === runtimePolicyIdentity(policy) && object(value.holds) &&
    (value.pending === null || object(value.pending)) && (value.settled === null || object(value.settled));
}
// This diagnostic projection never authorizes publication or artifact deletion.
// Other controller-state consumers keep their existing capability restrictions.
export function supportedDiagnosticController(state, policy) {
  if (policy?.schema !== 3) return supportedController(state);
  try {
    if (policy.routing !== 'durable' || !Array.isArray(state?.requirements) || !state.requirements.includes(routeAuthorityCapability) || !journalEnvelope(state.routeAuthority, policy)) return false;
    return supportedController({ ...state, requirements: state.requirements.filter(value => value !== routeAuthorityCapability) });
  } catch { return false; }
}
export function diagnosticRoutingPending(state, app, policy) {
  return policy.schema === 3 && (state.routeAuthority.pending !== null || Object.hasOwn(state.routeAuthority.holds, app));
}
