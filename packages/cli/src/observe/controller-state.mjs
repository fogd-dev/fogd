import { appArchiveRotationCapability } from '@fogd/platform/app-archive-rotation-state';
import { appArchiveCapability, validateAppArchives } from '@fogd/platform/app-archive';
import { routeAuthorityCapability } from '@fogd/platform/route-snapshot';
import { hasDurableRuntimeMode, runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { supportedController, object } from '../controller-schema.mjs';

const fields = ['holds', 'installation', 'pending', 'schema', 'settled'];
function journalEnvelope(value, policy) {
  if (!object(value) || Object.keys(value).sort().join() !== fields.join()) return false;
  return value.schema === 1 && value.installation === runtimePolicyIdentity(policy) && object(value.holds) &&
    (value.pending === null || object(value.pending)) && (value.settled === null || object(value.settled));
}
// This diagnostic projection never authorizes publication or artifact deletion.
// Other controller-state consumers keep their existing capability restrictions.
function archiveMetadata(state) {
  return Object.hasOwn(state || {}, 'appArchives') || Object.values(state?.apps || {}).some(app => app?.archive || app?.archiveRecovery || app?.route === 'archived');
}
export function supportedDiagnosticController(state, policy) {
  if (!hasDurableRuntimeMode(policy)) return !archiveMetadata(state) && supportedController(state);
  try {
    if (policy.routing !== 'durable' || !Array.isArray(state?.requirements) || !state.requirements.includes(routeAuthorityCapability) || !journalEnvelope(state.routeAuthority, policy)) return false;
    const excluded = [routeAuthorityCapability];
    if (policy.schema === 4) { validateAppArchives(state, policy); excluded.push(appArchiveCapability, appArchiveRotationCapability); }
    else if (archiveMetadata(state)) return false;
    return supportedController({ ...state, requirements: state.requirements.filter(value => !excluded.includes(value)) });
  } catch { return false; }
}
export function diagnosticRoutingPending(state, app, policy) {
  return hasDurableRuntimeMode(policy) && (state.routeAuthority.pending !== null || Object.hasOwn(state.routeAuthority.holds, app));
}
