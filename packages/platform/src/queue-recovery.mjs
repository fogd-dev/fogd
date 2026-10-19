import { randomUUID, createHash } from 'node:crypto';
import { deliveryFor } from './queue-activation.mjs';
import { queueRecoveryCapability, queueRetentionContract, snapshotTarget, validateSnapshot, validateQueueObservation, queueExpiry, assertSnapshotAge, assertRetentionContract } from './queue-snapshot.mjs';

export const recoveryPending = app => Boolean(app?.queueRecovery && app.queueRecovery.status !== 'acknowledged');
export const recoveryReview = receipt => createHash('sha256').update(JSON.stringify({ first: receipt.firstObservation || null, observed: receipt.observation || null, diagnoses: receipt.diagnoses || [], checkError: receipt.checkError || null })).digest('hex');
function activeInput(active, input) {
  if (input.deployment !== active.id || input.digest !== active.digest) throw new Error('Active deployment/digest changed; inspect delivery before recovery');
}
export async function prepareQueueSnapshot(controller, name, input) {
  const { app, active } = snapshotTarget(controller.state, name);
  activeInput(active, input);
  if (recoveryPending(app) || app.route !== 'active') throw new Error('Resolve restored queue recovery before taking another snapshot');
  const slot = controller.slots.find(value => value.id === app.slot);
  await deliveryFor(controller, app, slot).pause();
  const at = controller.clock(), observation = await controller.backend.queues.snapshot(slot, app.delivery.queue, active.version);
  const completedAt = controller.clock(); validateQueueObservation(observation, completedAt);
  const receipt = { schema: 1, id: randomUUID(), at, completedAt, queue: app.delivery.queue, slot: app.slot,
    deployment: active.id, digest: active.digest, version: active.version,
    contract: queueRetentionContract, observation, expiresAt: queueExpiry(observation, at) };
  assertSnapshotAge(receipt, completedAt);
  app.queueSnapshot = receipt; await controller.save();
  return { id: receipt.id, expiresAt: receipt.expiresAt };
}
export function validateRecoveryState(state) {
  for (const app of Object.values(state.apps)) {
    if (app.queueSnapshot) validateSnapshot(app.queueSnapshot);
    const receipt = app.queueRecovery;
    if (!receipt) continue;
    if (!state.requirements?.includes(queueRecoveryCapability) || !/^[a-f0-9-]{36}$/.test(receipt.id) || !['pending', 'acknowledged'].includes(receipt.status) || !/^[a-f0-9]{64}$/.test(receipt.snapshot) || !app.delivery) throw new Error('Invalid restored queue recovery state');
    validateSnapshot(receipt.prepared);
    if (receipt.status === 'pending' && (app.delivery.desired !== 'paused' || app.delivery.hold || app.uncertain)) throw new Error('Unresolved queue recovery must remain operator paused');
  }
}
async function inspectRecovery(controller, name, app) {
  const receipt = app.queueRecovery;
  assertRetentionContract(receipt.prepared);
  const slot = controller.slots.find(value => value.id === app.slot);
  const { active } = snapshotTarget(controller.state, name);
  if (active.id !== receipt.prepared.deployment || active.digest !== receipt.prepared.digest || active.version !== receipt.prepared.version || app.slot !== receipt.prepared.slot || app.delivery.queue !== receipt.prepared.queue) throw new Error('Restored queue approval differs from snapshot');
  await deliveryFor(controller, app, slot).pause();
  const observed = await controller.backend.queues.snapshot(slot, app.delivery.queue, active.version), at = controller.clock();
  let diagnosis = null;
  try {
    assertSnapshotAge(receipt.prepared, at);
    validateQueueObservation(observed, at);
    if (observed.backlogCount < receipt.prepared.observation.backlogCount) throw new Error('Restored backlog is smaller than snapshot observation');
    if (observed.oldestMessageTimestamp !== null && observed.oldestMessageTimestamp < (receipt.prepared.observation.oldestMessageTimestamp ?? receipt.prepared.at)) throw new Error('Restored queue contains older messages than snapshot observation');
  } catch { diagnosis = 'Possible message expiration or completion during snapshot shutdown; reconcile retained application input before acknowledging'; }
  receipt.firstObservation ||= { at, observed };
  receipt.checkedAt = at; receipt.observation = observed;
  if (diagnosis) recordDiagnosis(receipt, diagnosis);
  receipt.diagnosis ||= null;
  receipt.checkError = null;
}
function recordDiagnosis(receipt, diagnosis) {
  receipt.diagnoses = [...new Set([...(receipt.diagnoses || []), diagnosis])];
  receipt.diagnosis = receipt.diagnoses.join('; ');
}
export async function recoverQueueSnapshots(controller) {
  for (const [name, app] of Object.entries(controller.state.apps)) {
    if (!recoveryPending(app)) continue;
    app.route = 'paused';
    try { await checkRecovery(controller, name, app); } catch { controller.assertStorage(); }
    await controller.save();
  }
}
async function checkRecovery(controller, name, app) {
  try { await inspectRecovery(controller, name, app); }
  catch (error) {
    controller.assertStorage();
    const runtime = ['QUEUE_OUTCOME_UNKNOWN', 'QUEUE_SNAPSHOT_UNCONFIRMED'].includes(error.code);
    app.queueRecovery.checkError = runtime ? 'Queue runtime is unavailable or its approved generation is not ready; retry after the replicas recover' : 'Queue recovery approval, ownership, or retention contract differs; restore matching metadata and images';
    await controller.save();
    throw new Error(app.queueRecovery.checkError);
  }
}
export async function acknowledgeQueueRecovery(controller, name, input) {
  const { app, active } = snapshotTarget(controller.state, name);
  activeInput(active, input);
  if (!recoveryPending(app) || input.recovery !== app.queueRecovery.id || input.acceptPossibleLoss !== true) throw new Error('Acknowledge the current recovery ID and possible message loss explicitly');
  if (input.review !== recoveryReview(app.queueRecovery)) throw new Error('Recovery findings changed; inspect status and acknowledge again');
  await checkRecovery(controller, name, app);
  if (input.review !== recoveryReview(app.queueRecovery)) {
    await controller.save();
    throw new Error('Recovery findings changed; inspect status and acknowledge again');
  }
  app.queueRecovery.status = 'acknowledged'; app.queueRecovery.acknowledgedAt = controller.clock();
  app.route = 'active'; await controller.save();
}
