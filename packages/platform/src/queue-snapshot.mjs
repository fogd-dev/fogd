import { isDeepStrictEqual } from 'node:util';

export const queueRecoveryCapability = 'fogd-queue-recovery-v1';
// Production constant; overrides exist only under celld_internal_tests.
// crates/logic/queue.rs:37 and crates/celld/queue_policy.rs:393-400.
export const queueRetentionContract = Object.freeze({ runtime: 'celld 0.6.2',
  source: '90b43017241f81189453d326d05948f388b34652',
  image: 'sha256:b85983dcf410bcf710bbc30f400d8654123cb2b541ca4d84d7e299009a6ee97a',
  retentionMs: 4 * 24 * 60 * 60 * 1000, clockMarginMs: 60000 });

export function snapshotTarget(state, name) {
  const app = state.apps[name], active = state.deployments[app?.active];
  if (!app?.delivery || !active || active.app !== name || active.status !== 'active' || app.quarantined || app.retirement || app.uncertain || app.delivery.hold || blockedDeliveryOperation(app) || app.queueBootstrap?.phase !== 'application' || app.delivery.version !== active.version) throw new Error('Queue recovery requires a completed active deployment with reconciled delivery');
  return { app, active };
}
function blockedDeliveryOperation(app) {
  // A restored queue may have recorded pause intent before its replicas were
  // available. Retrying that pause is safe; no other unconfirmed effect is.
  return app.delivery.operation && !(app.queueRecovery?.status === 'pending' && app.delivery.operation === 'pause');
}
export function validateQueueObservation(value, at) {
  if (!Number.isSafeInteger(at) || at < 0 || value?.paused !== true || !['stored', 'backlogCount', 'backlogBytes'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) throw new Error('Invalid paused queue observation');
  if (value.stored !== value.backlogCount) throw new Error('Queue contains expired or unsettled records; reconcile before snapshot');
  const oldest = value.oldestMessageTimestamp;
  if (value.backlogCount === 0 ? oldest !== null : !Number.isSafeInteger(oldest) || oldest < 0 || oldest > at) throw new Error('Queue oldest timestamp does not match its backlog or clock');
}
export function queueExpiry(observation, at, contract = queueRetentionContract) {
  return Math.min(observation.oldestMessageTimestamp ?? at, at) + contract.retentionMs - contract.clockMarginMs;
}
export function validateSnapshot(receipt) {
  if (!receipt || receipt.schema !== 1 || !/^[a-f0-9-]{36}$/.test(receipt.id) || typeof receipt.queue !== 'string' || typeof receipt.slot !== 'string' || typeof receipt.version !== 'string' || !receipt.version || typeof receipt.deployment !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.digest)) throw new Error('Invalid queue snapshot receipt');
  const contract = receipt.contract;
  validateRecordedContract(contract);
  if (!Number.isSafeInteger(receipt.at) || receipt.at < 0 || receipt.completedAt < receipt.at) throw new Error('Invalid queue snapshot observation interval');
  validateQueueObservation(receipt.observation, receipt.completedAt);
  if (receipt.expiresAt !== queueExpiry(receipt.observation, receipt.at, contract)) throw new Error('Invalid queue snapshot retention bound');
}
function validateRecordedContract(contract) {
  if (!contract || !['runtime', 'source', 'image'].every(key => typeof contract[key] === 'string' && contract[key]) || !Number.isSafeInteger(contract.retentionMs) || !Number.isSafeInteger(contract.clockMarginMs) || contract.clockMarginMs < 0 || contract.retentionMs <= contract.clockMarginMs) throw new Error('Invalid recorded queue retention contract');
}
export function assertRetentionContract(receipt) {
  if (!isDeepStrictEqual(receipt.contract, queueRetentionContract)) throw new Error('Queue snapshot requires its supported pinned retention contract');
}
export function matchingSnapshot(state, name, receipt) {
  validateSnapshot(receipt); assertRetentionContract(receipt);
  const { app, active } = snapshotTarget(state, name);
  if (receipt.queue !== app.delivery.queue || receipt.slot !== app.slot || receipt.version !== active.version || receipt.deployment !== active.id || receipt.digest !== active.digest) throw new Error('Queue snapshot differs from the active approval');
  if (app.route !== 'active' || app.delivery.desired !== 'paused' || app.delivery.observed !== 'paused') throw new Error('Queue snapshot requires active routing and confirmed operator pause');
  return app;
}
export function assertSnapshotAge(receipt, now) {
  assertRetentionContract(receipt);
  if (!Number.isSafeInteger(now) || now < receipt.at - receipt.contract.clockMarginMs || now >= receipt.expiresAt) throw new Error('Queue snapshot is expired or the restore clock is outside its supported bound; retain the bundle and reconcile application input');
}
