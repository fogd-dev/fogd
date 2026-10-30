import { artifactOnlyQueueRequest, hasQueueLifecycle } from '@fogd/platform/queue-history';
import { validateRetiredQueue, queueRetirementCapability } from '@fogd/platform/queue-retirement';
import { snapshotEvidence } from './snapshot-evidence.mjs';
import { assertSnapshotState } from './snapshot-state-validation.mjs';
import { snapshotTarget, matchingSnapshot, assertSnapshotAge, queueRecoveryCapability } from '@fogd/platform/queue-snapshot';
import { assertQueueFreeRecovery } from './queue-safety.mjs';

export function queueBackupApps(state) {
  const requirements = state?.requirements || [];
  if (!requirements.includes('fogd-queue-activation-v1')) { assertQueueFreeRecovery(state); return []; }
  assertSnapshotState(state, ['fogd-queue-activation-v1', queueRecoveryCapability, queueRetirementCapability, 'fogd-retirement-v1', 'fogd-claim-intent-v1']);
  return queueRecoveryApps(state);
}

// Family inventory; callers must validate the installation's other capabilities.
export function queueRecoveryApps(state, archived = []) {
  if (!state.requirements?.includes('fogd-queue-activation-v1')) {
    if (state.requirements?.some(value => [queueRecoveryCapability, queueRetirementCapability].includes(value)) || Object.values(state.apps).some(hasQueueLifecycle) || Object.values(state.deployments).some(value => Object.hasOwn(value.resources || {}, 'queues'))) throw new Error('Queue history requires its capability marker');
    return [];
  }
  const retired = Object.keys(state.apps).filter(name => validateRetiredQueue(state, name, state.apps[name]));
  const names = Object.keys(state.apps).filter(name => !state.apps[name].retirement && hasQueueLifecycle(state.apps[name]));
  const artifacts = Object.values(state.deployments).filter(request => artifactOnlyQueueRequest(state, request));
  const accounted = [...names, ...retired, ...archived];
  if ((!accounted.length && !artifacts.length) || Object.values(state.deployments).some(value => value.resources?.queues && !artifacts.includes(value) && (!accounted.includes(value.app) || (retired.includes(value.app) && !['retired', 'superseded', 'rejected'].includes(value.status))))) throw new Error('Queued installation recovery requires an activated app for every queue declaration');
  for (const name of names) {
    const { app } = snapshotTarget(state, name);
    if (app.queueRecovery && app.queueRecovery.status !== 'acknowledged') throw new Error('Acknowledge existing queue recovery before backup');
  }
  return names.sort();
}
export const queueSnapshotProtocol = { name: 'Queue', recovery: 'queueRecovery', capability: queueRecoveryCapability, legacy: 'queued', field: 'queueSnapshot', match: matchingSnapshot, check: assertSnapshotAge };

export function queueSnapshotEvidence(state, expected, now = Date.now()) {
  return snapshotEvidence(state, queueBackupApps(state), expected, queueSnapshotProtocol, now);
}
