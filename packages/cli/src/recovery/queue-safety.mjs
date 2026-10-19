import { artifactOnlyQueueRequest, hasQueueLifecycle } from '@fogd/platform/queue-history';
import { snapshotState } from './snapshot-state.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasQueueResources = value => record(value.resources) && Object.hasOwn(value.resources, 'queues');

// This is a recovery qualification boundary, not the controller's state validator.
// The capability also covers pending/rejected artifacts and survives their removal.
export function assertQueueFreeRecovery(state) {
  if (!record(state) || !record(state.apps) || !record(state.deployments) ||
      (state.requirements !== undefined && !Array.isArray(state.requirements))) {
    throw new Error('Cannot establish recovery support from controller metadata');
  }
  const apps = Object.values(state.apps), deployments = Object.values(state.deployments);
  if ([...apps, ...deployments].some(value => !record(value))) throw new Error('Cannot establish recovery support from controller metadata');
  const declared = deployments.filter(hasQueueResources);
  const artifactOnly = declared.length > 0 && declared.every(request => artifactOnlyQueueRequest(state, request));
  if ((state.requirements?.includes('fogd-queue-activation-v1') && !artifactOnly) ||
      apps.some(hasQueueLifecycle) || (declared.length > 0 && !artifactOnly)) {
    throw new Error('Queued installation recovery is not qualified: pause does not freeze message retention. Keep source data and partial archives; restore and transformations are unsupported. See docs/queue-recovery.md');
  }
  if (state.requirements?.some(value => !['fogd-retirement-v1', 'fogd-claim-intent-v1', ...(artifactOnly ? ['fogd-queue-activation-v1'] : [])].includes(value))) throw new Error('Controller metadata requires an unsupported recovery capability');
}

export async function assertSnapshotQueueFree(directory, archive = 'controller.tar') {
  assertQueueFreeRecovery(await snapshotState(directory, archive));
}

export function assertQueueFreeMetadata(input) {
  let state;
  try { state = JSON.parse(input); }
  catch { throw new Error('Cannot read controller metadata for recovery'); }
  assertQueueFreeRecovery(state);
}
