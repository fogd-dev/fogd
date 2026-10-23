import { applicationInspection } from '../inspection.mjs';
import { supportedController, supportedApplication, applicationOperationPending, applicationRecoveryPending } from '../controller-schema.mjs';
import { observationKey } from './fingerprint.mjs';
import { artifactPruneStatus } from '@fogd/platform/artifact-prune-state';

function recordedObservation(state, app) {
  if (!supportedController(state)) throw new Error('Local controller state is unsupported; native readiness is unknown');
  const publicState = state.artifactPruning ? { ...state, artifactPruning: artifactPruneStatus(state) } : state;
  const recorded = applicationInspection(publicState, app);
  if (recorded.active && (typeof recorded.active.id !== 'string' || typeof recorded.active.digest !== 'string')) throw new Error('Local controller release identity is unsupported; native readiness is unknown');
  return recorded;
}

export function observationSelection(state, app, policy) {
  const recorded = recordedObservation(state, app), item = state.apps[app];
  const base = { app, recorded: { source: 'local-controller-disk', routing: recorded.routing, active: recorded.active }, key: observationKey(state, app), reason: 'no-active-approved-release' };
  if (state.artifactPruning?.operation) return { ...base, reason: 'controller-artifact-prune-pending' };
  if (!item || !recorded.active) return base;
  if (!supportedApplication(item, ['queueSnapshot', 'cronSnapshot'])) return { ...base, reason: 'unsupported-controller-state' };
  if (withheld(item, recorded)) return { ...base, reason: 'controller-withholds-application' };
  const release = state.deployments[recorded.active.id];
  const fleet = policy.fleets.find(value => value.id === item.slot);
  if (!fleet || release.status !== 'active' || release.step !== 'complete' || typeof release.version !== 'string' || !release.version || release.version.length > 512) return { ...base, reason: 'unverified-approved-version' };
  return { ...base, reason: null, fleet, expected: { ...recorded.active, version: release.version, slot: item.slot } };
}
function withheld(item, recorded) {
  return recorded.routing !== 'active' || applicationOperationPending(item) || applicationRecoveryPending(item);
}
const httpStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
function replicaView(node, sample) {
  const row = Array.isArray(sample?.replicas) ? sample.replicas.find(value => value?.node === node.host) : null;
  return { node: node.host, stateHTTPStatus: httpStatus(row?.stateHTTPStatus), healthHTTPStatus: httpStatus(row?.healthHTTPStatus),
    version: ['matches', 'differs', 'unknown'].includes(row?.version) ? row.version : 'unknown' };
}
export function observationReport(selection, { installation, boundary, controllerProcess, observedAt }, sample) {
  const replicas = (selection.fleet?.nodes || []).map(node => replicaView(node, sample));
  const identity = sample?.identity === 'verified' ? 'verified' : 'unconfirmed';
  const consistent = boundary === 'matched-at-boundaries' && controllerProcess === 'running-at-boundaries';
  const confirmed = !selection.reason && !sample?.unavailable && consistent && identity === 'verified' && replicas.length > 0 && replicas.every(row => row.stateHTTPStatus === 200 && row.healthHTTPStatus === 200 && row.version === 'matches');
  return { schema: 1, app: selection.app, installation, observedAt, source: 'local-native-observation', recorded: selection.recorded,
    nativeReadiness: confirmed ? 'confirmed' : selection.reason && !selection.recorded.active ? 'not-observed' : 'uncertain',
    reason: readinessReason(selection, { boundary, controllerProcess }, sample, confirmed),
    controllerRecord: boundary, controllerProcess, controllerStorageHealth: 'not-observed', runtimeIdentity: selection.reason ? 'not-observed' : identity,
    replicas, applicationOutcomes: 'not-observed' };
}

function readinessReason(selection, context, sample, confirmed) {
  if (selection.reason) return selection.reason;
  if (context.boundary !== 'matched-at-boundaries') return 'controller-record-unconfirmed';
  if (sample?.unavailable === 'scope-unconfirmed') return 'local-scope-unconfirmed';
  if (context.controllerProcess !== 'running-at-boundaries') return 'controller-process-unconfirmed';
  if (!sample || sample.unavailable === 'helper-failed') return 'observer-unavailable';
  if (sample.unavailable === 'timeout') return 'observer-timeout';
  if (sample.identity !== 'verified') return 'runtime-identity-unconfirmed';
  return confirmed ? null : 'replica-readiness-unconfirmed';
}
