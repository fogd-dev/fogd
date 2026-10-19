import { isDeepStrictEqual } from 'node:util';
import { snapshotTarget, matchingSnapshot, assertSnapshotAge, queueRecoveryCapability } from '@fogd/platform/queue-snapshot';
import { assertQueueFreeRecovery } from './queue-safety.mjs';
import { prepareSnapshotRequest } from '../platform.mjs';

export function queueBackupApps(state) {
  const requirements = state?.requirements || [];
  if (!requirements.includes('fogd-queue-activation-v1')) { assertQueueFreeRecovery(state); return []; }
  if (requirements.some(value => !['fogd-queue-activation-v1', queueRecoveryCapability, 'fogd-retirement-v1', 'fogd-claim-intent-v1'].includes(value))) throw new Error('Unsupported snapshot capability');
  const names = Object.keys(state.apps).filter(name => state.apps[name].resources?.queues || state.apps[name].delivery);
  if (!names.length || Object.values(state.deployments).some(value => value.resources?.queues && !names.includes(value.app))) throw new Error('Queued installation recovery requires an activated app for every queue declaration');
  for (const name of names) {
    const { app } = snapshotTarget(state, name);
    if (app.queueRecovery && app.queueRecovery.status !== 'acknowledged') throw new Error('Acknowledge existing queue recovery before backup');
  }
  return names.sort();
}
export async function prepareQueueBackup(env, state, images, replicas) {
  const names = queueBackupApps(state), expected = {};
  if (names.length && replicas.some(name => images[name] !== images.controller)) throw new Error('Queued backup requires identical pinned controller and replica runtime images');
  for (const name of names) {
    const active = state.deployments[state.apps[name].active];
    const receipt = await prepareSnapshotRequest(env, name, { deployment: active.id, digest: active.digest });
    expected[name] = receipt.id;
  }
  return expected;
}
export function queueSnapshotEvidence(state, expected, now = Date.now()) {
  const names = queueBackupApps(state);
  if (!isDeepStrictEqual(names, Object.keys(expected).sort())) throw new Error('Queue inventory changed during backup');
  if (!names.length) return null;
  const apps = {};
  for (const name of names) {
    const receipt = state.apps[name].queueSnapshot;
    if (!receipt || receipt.id !== expected[name]) throw new Error('Queue snapshot preparation changed during shutdown');
    matchingSnapshot(state, name, receipt); assertSnapshotAge(receipt, now);
    apps[name] = receipt;
  }
  return { schema: 1, apps };
}
