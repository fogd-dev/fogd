import { isDeepStrictEqual } from 'node:util';
import { cronScript, validateCronDispatch } from './cron-dispatch.mjs';

export const cronRecoveryCapability = 'fogd-cron-recovery-v1';
export const cronRecoveryNotice = 'Pausing clears pending timer and retry identity. Resume schedules a future occurrence; unfinished work is not a retained backlog. An older snapshot can lose acknowledged results or replay external effects. Reconcile application records before acknowledging.';
export const cronRecoveryPending = app => Boolean(app?.cronRecovery && app.cronRecovery.status !== 'acknowledged');

export function cronSnapshotTarget(state, name) {
  const app = state.apps[name], active = state.deployments[app?.active];
  if (!app?.dispatch || !active || active.app !== name || active.status !== 'active' || !Object.hasOwn(active, 'secretRevision')) throw new Error('Cron recovery requires a completed active approval');
  assertSnapshotControl(app, active);
  if (app.dispatch.operation && !(cronRecoveryPending(app) && app.dispatch.operation === 'pause')) throw new Error('Reconcile the unfinished cron operation before recovery');
  if (cronScript(active.resources) !== name || cronScript(app.resources) !== name || !isDeepStrictEqual(active.resources.crons, app.resources.crons)) throw new Error('Cron recovery declaration differs from approval');
  return { app, active };
}
function assertSnapshotControl(app, active) {
  if (app.quarantined || app.retirement || app.uncertain || app.dispatch.hold || app.cronBootstrap?.phase !== 'application' || active.version !== app.dispatch.version) throw new Error('Cron recovery requires reconciled dispatch for its active approval');
}
export function validateCronObservation(value, crons) {
  if (value?.paused !== true || value.nextAlarm !== null || !Number.isSafeInteger(value.revision) || value.revision < 0 || !isDeepStrictEqual(value.crons, crons)) throw new Error('Cron snapshot requires a confirmed held approved schedule');
}
function validateSnapshotIdentity(receipt) {
  if (receipt?.schema !== 1 || !/^[a-f0-9-]{36}$/.test(receipt.id)) throw new Error('Invalid cron snapshot receipt');
  if (!['script', 'slot', 'deployment', 'version'].every(key => typeof receipt[key] === 'string' && receipt[key])) throw new Error('Invalid cron snapshot identity');
  if (!/^[a-f0-9]{64}$/.test(receipt.digest)) throw new Error('Invalid cron snapshot digest');
  if (receipt.secretRevision !== null && (typeof receipt.secretRevision !== 'string' || !receipt.secretRevision)) throw new Error('Invalid cron snapshot secret revision');
  if (!Array.isArray(receipt.crons) || !receipt.crons.length || !receipt.crons.every(cron => typeof cron === 'string' && cron.trim())) throw new Error('Invalid cron snapshot schedule');
}
function validateBeforePause(before, crons) {
  if (typeof before?.paused !== 'boolean' || !Number.isSafeInteger(before.revision) || before.revision < 0 || !isDeepStrictEqual(before.crons, crons)) throw new Error('Invalid pre-pause cron observation');
  if (before.nextAlarm !== null && (!Number.isSafeInteger(before.nextAlarm) || before.nextAlarm < 0)) throw new Error('Invalid pre-pause cron alarm');
  if (before.paused && before.nextAlarm !== null) throw new Error('Held pre-pause cron alarm is armed');
}
export function validateCronSnapshot(receipt) {
  validateSnapshotIdentity(receipt);
  if (!Number.isSafeInteger(receipt.at) || receipt.at < 0 || !Number.isSafeInteger(receipt.completedAt) || receipt.completedAt < receipt.at) throw new Error('Invalid cron snapshot observation interval');
  validateBeforePause(receipt.beforePause, receipt.crons);
  validateCronObservation(receipt.observation, receipt.crons);
  const expected = receipt.beforePause.revision + (receipt.beforePause.paused ? 0 : 1);
  if (!Number.isSafeInteger(expected) || receipt.observation.revision !== expected) throw new Error('Cron control changed outside snapshot pause');
}
export function matchingCronSnapshot(state, name, receipt) {
  validateCronSnapshot(receipt);
  const { app, active } = cronSnapshotTarget(state, name);
  if (receipt.script !== name || receipt.slot !== app.slot || receipt.deployment !== active.id || receipt.digest !== active.digest || receipt.version !== active.version || receipt.secretRevision !== active.secretRevision || !isDeepStrictEqual(receipt.crons, active.resources.crons)) throw new Error('Cron snapshot differs from its exact approval');
  validateCronDispatch(app.dispatch);
  if (app.route !== 'active' || app.dispatch.desired !== 'paused' || app.dispatch.observed !== 'paused' || app.dispatch.operation) throw new Error('Cron snapshot requires active routing and confirmed operator pause');
  return app;
}
