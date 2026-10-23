import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { artifactDigest } from '@fogd/runtime/artifact';
import { dispatchFor } from './cron-activation.mjs';
import { cronRecoveryNotice, cronRecoveryPending, cronSnapshotTarget, validateCronSnapshot, validateCronObservation } from './cron-snapshot.mjs';
import { recoveryReview } from './recovery-review.mjs';

function activeInput(active, input) {
  if (input.deployment !== active.id || input.digest !== active.digest) throw new Error('Active deployment/digest changed; inspect dispatch before recovery');
}
function sameApproval(app, active, prepared) {
  if (prepared.script !== active.app || prepared.slot !== app.slot || prepared.deployment !== active.id || prepared.digest !== active.digest || prepared.version !== active.version || prepared.secretRevision !== active.secretRevision || !isDeepStrictEqual(prepared.crons, active.resources.crons)) throw recoveryMismatch('Restored cron approval differs from snapshot');
}
function recoveryMismatch(message) {
  const error = new Error(message); error.code = 'CRON_RECOVERY_MISMATCH'; return error;
}
export async function prepareCronSnapshot(controller, name, input) {
  const { app, active } = cronSnapshotTarget(controller.state, name); activeInput(active, input);
  await controller.routes.snapshotReady(name, active);
  if (cronRecoveryPending(app) || app.route !== 'active') throw new Error('Acknowledge restored cron recovery before another snapshot');
  if (await artifactDigest(controller.artifact(active.id)) !== active.digest) throw new Error('Stored artifact digest mismatch');
  await controller.secrets.select(active, active.secretRevision);
  const slot = controller.slots.find(value => value.id === app.slot), at = controller.clock();
  try {
    const beforePause = await controller.backend.crons.status(slot, app.dispatch.script);
    await dispatchFor(controller, app, slot).pause();
    const observation = await controller.backend.crons.snapshot(slot, app.dispatch.script, active.version), completedAt = controller.clock();
    const receipt = { schema: 1, id: randomUUID(), at, completedAt, script: name, slot: app.slot,
      deployment: active.id, digest: active.digest, version: active.version, secretRevision: active.secretRevision,
      crons: structuredClone(active.resources.crons), beforePause, observation };
    validateCronSnapshot(receipt); app.cronSnapshot = receipt; await controller.save(); return { id: receipt.id };
  } catch (cause) {
    controller.assertStorage();
    const error = new Error('Cron snapshot could not confirm the held approved runtime; inspect dispatch before retrying', { cause });
    error.code = 'CRON_SNAPSHOT_UNCONFIRMED'; throw error;
  }
}
export { validateCronRecoveryState } from './cron-snapshot.mjs';

function diagnose(receipt, text) {
  receipt.diagnoses = [...new Set([...(receipt.diagnoses || []), text])]; receipt.diagnosis = receipt.diagnoses.join('; ');
}
async function inspectRecovery(controller, name, app) {
  await controller.routes.beforeEffect(app, controller.slots.find(slot => slot.id === app.slot));
  const receipt = app.cronRecovery, { active } = cronSnapshotTarget(controller.state, name);
  const slot = controller.slots.find(value => value.id === app.slot);
  const before = await controller.backend.crons.status(slot, app.dispatch.script);
  if (!before.paused || before.nextAlarm !== null || receipt.unexpectedDispatch) {
    receipt.unexpectedDispatch = true;
    diagnose(receipt, 'Restored native dispatch was not held; work may have run before confirmation. Restore a qualified stopped snapshot.');
    await controller.save(); await dispatchFor(controller, app, slot).pause();
    throw new Error('Unexpected restored native dispatch');
  }
  sameApproval(app, active, receipt.prepared);
  if (receipt.unexpectedRevision) throw recoveryMismatch('Restored hold revision previously differed from snapshot');
  validateCronObservation(before, receipt.prepared.crons);
  await assertRestoredRevision(controller, receipt, before);
  await dispatchFor(controller, app, slot).pause();
  const observed = await controller.backend.crons.snapshot(slot, app.dispatch.script, active.version);
  validateCronObservation(observed, receipt.prepared.crons);
  await assertRestoredRevision(controller, receipt, observed);
  const at = controller.clock(); receipt.firstObservation ||= { at, observed: structuredClone(observed) };
  receipt.checkedAt = at; receipt.observation = observed; receipt.checkError = null;
}
async function assertRestoredRevision(controller, receipt, observed) {
  if (observed.revision === receipt.prepared.observation.revision) return;
  receipt.unexpectedRevision = true;
  diagnose(receipt, 'Restored native hold revision differs from snapshot; control history or stored state changed. Work may have run. Restore a qualified stopped snapshot.');
  await controller.save();
  throw recoveryMismatch('Restored hold revision differs from snapshot');
}
function recoveryError(receipt, error) {
  if (receipt.unexpectedDispatch) return 'Restored dispatch was not held; restore a qualified stopped snapshot before using this app';
  if (error.code === 'CRON_RECOVERY_MISMATCH') return 'Cron recovery approval or hold revision differs from snapshot; restore matching metadata, volumes and images';
  return 'Cron hold or approved runtime could not be confirmed; retry after its replicas recover, or restore matching metadata and images';
}
async function checkRecovery(controller, name, app) {
  try { await inspectRecovery(controller, name, app); }
  catch (error) {
    controller.assertStorage();
    app.cronRecovery.checkError = recoveryError(app.cronRecovery, error);
    await controller.save();
    const failure = new Error(app.cronRecovery.checkError); failure.code = 'CRON_RECOVERY_UNCONFIRMED'; throw failure;
  }
}
export async function recoverCronSnapshots(controller) {
  for (const [name, app] of Object.entries(controller.state.apps)) {
    if (!cronRecoveryPending(app)) continue;
    app.route = 'paused';
    try { await checkRecovery(controller, name, app); } catch { controller.assertStorage(); }
    await controller.save();
  }
}
export async function acknowledgeCronRecovery(controller, name, input) {
  await controller.routes.checkReady();
  const { app, active } = cronSnapshotTarget(controller.state, name); activeInput(active, input);
  const receipt = app.cronRecovery;
  if (!cronRecoveryPending(app) || input.recovery !== receipt.id || input.acceptPossibleLoss !== true) throw new Error('Acknowledge the current recovery ID and possible loss or replay explicitly');
  if (input.review !== recoveryReview(receipt)) throw new Error('Recovery findings changed; inspect status and acknowledge again');
  await checkRecovery(controller, name, app);
  if (input.review !== recoveryReview(receipt)) { await controller.save(); throw new Error('Recovery findings changed; inspect status and acknowledge again'); }
  await controller.routes.verifyRecovery(name, active);
  receipt.status = 'acknowledged'; receipt.acknowledgedAt = controller.clock(); app.route = 'active'; await controller.routes.complete(active);
}
export function cronRecoveryView(receipt) {
  if (!receipt) return null;
  return { id: receipt.id, status: receipt.status, review: recoveryReview(receipt), notice: cronRecoveryNotice,
    diagnoses: receipt.diagnoses || [], checkError: receipt.checkError || null, checkedAt: receipt.checkedAt || null,
    observation: receipt.observation || null, firstObservation: receipt.firstObservation || null };
}
