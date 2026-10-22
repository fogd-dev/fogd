import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeObservation, setFailurePolicy } from './observations.mjs';
import { waitFor } from './https.mjs';
import { rows } from './recovery-ledger.mjs';

export async function beginFailurePhase(host, active, phase, clock) {
  const held = await pauseFailureWork(host, active, clock);
  const control = await setFailurePolicy(host, active, phase), requestedAt = await clock();
  const resumed = await host.json(['admin', 'dispatch', 'refresh', 'resume', active.id, active.digest]); assert.equal(resumed.observed, 'running');
  return { phase, quiescence: held.quiescence, held: { start: held.heldAt, end: requestedAt }, confirmedPauseAt: held.confirmedAt, control, resume: { requestedAt, returnedAt: await clock(), observed: resumed.observed } };
}
export async function firstFailureOccurrence(host, active, selected, cron = '* * * * *') {
  const value = await waitFor('both native jobs entered and finished', async () => {
    const observed = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    const phaseRows = rows(observed, 'cron_fault_attempts').filter(row => row.phase === selected.phase);
    if (!phaseRows.length) return false;
    const time = Math.min(...phaseRows.map(row => row.scheduled_time)), attempts = phaseRows.filter(row => row.scheduled_time === time);
    const settled = ['inventory', 'advisory'].every(job => attempts.some(row => row.job === job && row.outcome !== 'pending'));
    const successesVisible = attempts.filter(row => row.outcome === 'success').every(row => completedJob(observed, row.job, time));
    return settled && successesVisible && { observed, time, attempts };
  }, cron === '* * * * *' ? 150000 : 240000);
  assert.ok(Number.isSafeInteger(value.time) && value.time > selected.resume.requestedAt && value.time % 60000 === 0);
  assert.ok(value.attempts.every(row => row.cron === cron && row.entered_at >= value.time));
  return value;
}
export function hasSuccessfulOccurrence(observed, time) {
  return ['inventory', 'advisory'].every(job =>
    rows(observed, 'cron_fault_attempts').some(row => row.job === job && row.scheduled_time === time && row.outcome === 'success') && completedJob(observed, job, time));
}
function completedJob(observed, job, time) {
  return rows(observed, 'refresh_occurrences').some(row => row.job === job && row.scheduled_time === time && row.status === 'complete') &&
    rows(observed, 'refresh_results').filter(row => row.job === job && row.scheduled_time === time).length === 1;
}

export function assertHealthyOccurrence(value) {
  assert.ok(hasSuccessfulOccurrence(value.observed, value.time));
  assert.deepEqual(value.attempts.map(row => [row.job, row.outcome, row.no_retry_called]).sort(), [['advisory', 'success', 0], ['inventory', 'success', 0]]);
  for (const job of ['inventory', 'advisory']) assert.equal(rows(value.observed, 'refresh_occurrences').find(row => row.job === job && row.scheduled_time === value.time).attempts, 1);
}

export async function pauseFailureWork(host, active, clock) {
  const paused = await host.json(['admin', 'dispatch', 'refresh', 'pause']); assert.equal(paused.observed, 'paused');
  const heldAt = Date.parse(paused.observedAt), confirmedAt = await clock(); assert.ok(Number.isSafeInteger(heldAt) && heldAt <= confirmedAt);
  const quiescence = [];
  const observed = await waitFor('settled recorded callbacks after confirmed pause', async () => {
    const value = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    const pending = rows(value, 'cron_fault_attempts').filter(row => row.outcome === 'pending');
    quiescence.push({ at: await clock(), pending }); assert.equal(value.status.paused, true); assert.equal(value.status.nextAlarm, null);
    return pending.length === 0 && value;
  }, 30000);
  return { paused, heldAt, confirmedAt, quiescence, observed };
}

export async function waitFailureTime(clock, deadline) {
  assert.ok(Number.isSafeInteger(deadline) && deadline > 0);
  let now = await clock();
  while (now < deadline) { await delay(Math.min(1000, deadline - now)); now = await clock(); }
  return now;
}
