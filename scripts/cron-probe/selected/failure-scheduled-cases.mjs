import assert from 'node:assert/strict';
import { beginFailurePhase, firstFailureOccurrence, hasSuccessfulOccurrence, assertHealthyOccurrence } from './failure-phases.mjs';
import { assertNoRetry, assertCountedTerminal } from './failure-outcomes.mjs';
import { nativeObservation } from './observations.mjs';
import { rows } from './recovery-ledger.mjs';
import { waitFor } from './https.mjs';

export async function futureFailureWake(host, active, time, period) {
  const observed = await waitFor('next natural schedule durably armed', async () => {
    const value = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    return value.status.paused === false && value.status.nextAlarm === time + period && value.cronRecords.wakes.some(row => row.due_ms === time + period) && value;
  }, 200000);
  return observed;
}
export async function selectedNoRetry({ host, active, clock, evidence }) {
  const selected = await beginFailurePhase(host, active, 'no-retry', clock); evidence.phase = selected;
  const first = await firstFailureOccurrence(host, active, selected); evidence.first = first; assertNoRetry(first.attempts);
  const following = await waitFor('next natural noRetry occurrence without pause', async () => {
    const observed = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    const attempts = rows(observed, 'cron_fault_attempts').filter(row => row.phase === 'no-retry' && row.scheduled_time === first.time + 60000);
    return ['inventory', 'advisory'].every(job => attempts.some(row => row.job === job && row.outcome !== 'pending')) && { observed, attempts };
  }, 150000);
  evidence.following = following; assertNoRetry(following.attempts);
  assert.deepEqual(rows(following.observed, 'cron_fault_attempts').filter(row => row.phase === 'no-retry' && row.scheduled_time === first.time), first.attempts);
  evidence.advanced = await futureFailureWake(host, active, first.time + 60000, 60000);
  evidence.healthy = await beginFailurePhase(host, active, 'no-retry-future', clock);
  evidence.healthy.first = await firstFailureOccurrence(host, active, evidence.healthy); assertHealthyOccurrence(evidence.healthy.first);
  assert.deepEqual(rows(evidence.healthy.first.observed, 'cron_fault_attempts').filter(row => row.phase === 'no-retry' && row.scheduled_time === first.time), first.attempts);
}
export async function selectedTerminal({ host, active, clock, defaults, evidence }) {
  const selected = await beginFailurePhase(host, active, 'terminal', clock); evidence.phase = selected;
  const first = await firstFailureOccurrence(host, active, selected, '*/3 * * * *'); evidence.first = first;
  evidence.counted = await waitFor('six settled native attempts per job', async () => {
    const observed = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    const attempts = rows(observed, 'cron_fault_attempts').filter(row => row.phase === 'terminal' && row.scheduled_time === first.time);
    evidence.lastCountedSample = { at: observed.cronRecords.at, attempts };
    return attempts.length === 12 && attempts.every(row => row.outcome !== 'pending') && observed;
  }, 180000);
  const attempts = rows(evidence.counted, 'cron_fault_attempts').filter(row => row.phase === 'terminal' && row.scheduled_time === first.time);
  evidence.advanced = await futureFailureWake(host, active, first.time, 180000);
  assertCountedTerminal(attempts, first.time, defaults); evidence.attempts = attempts;
  assert.deepEqual(rows(evidence.advanced, 'refresh_results').filter(row => row.scheduled_time === first.time).map(row => row.job), ['inventory']);
  evidence.healthy = await beginFailurePhase(host, active, 'terminal-future', clock);
  evidence.healthy.first = await firstFailureOccurrence(host, active, evidence.healthy, '*/3 * * * *'); assertHealthyOccurrence(evidence.healthy.first);
  assert.deepEqual(rows(evidence.healthy.first.observed, 'cron_fault_attempts').filter(row => row.phase === 'terminal' && row.scheduled_time === first.time), attempts);
}
export async function completedFailureOccurrence(host, active, time, phase) {
  return waitFor('native occurrence and unique business results complete', async () => {
    const observed = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    const attempts = rows(observed, 'cron_fault_attempts').filter(row => row.phase === phase && row.scheduled_time === time);
    return attempts.length === 2 && attempts.every(row => row.outcome === 'success') && hasSuccessfulOccurrence(observed, time) && { observed, time, attempts };
  }, 150000);
}
