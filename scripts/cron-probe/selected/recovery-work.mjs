import assert from 'node:assert/strict';
import { nativeObservation, vmTime } from './observations.mjs';
import { waitFor } from './https.mjs';
import { selectedRetry } from './retry-selection.mjs';
import { rows, noReplay } from './recovery-ledger.mjs';

export async function resumeCron(host, active) {
  const requestedAt = await vmTime(host);
  const confirmed = await host.json(['admin', 'dispatch', active.app, 'resume', active.id, active.digest]);
  assert.equal(confirmed.observed, 'running'); return { requestedAt, confirmedAt: await vmTime(host), confirmed };
}
export async function armedTimer(host, active) {
  return waitFor('armed future minute with backup margin', async () => {
    const observed = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    return observed.status.paused === false && observed.status.nextAlarm - await vmTime(host) > 25000 && observed;
  }, 150000);
}
export async function futurePhase(host, active, phase, since, timeout = 180000) {
  return waitFor('autonomous successful refresh phase', async () => {
    const observed = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    const attempts = rows(observed, 'cron_fault_attempts').filter(row => row.phase === phase && row.scheduled_time > since && row.outcome === 'success');
    const occurrences = rows(observed, 'refresh_occurrences'), results = rows(observed, 'refresh_results');
    return ['inventory', 'advisory'].every(job => attempts.some(row => row.job === job &&
      occurrences.some(value => value.job === job && value.scheduled_time === row.scheduled_time && value.status === 'complete') &&
      results.some(value => value.job === job && value.scheduled_time === row.scheduled_time))) && observed;
  }, timeout);
}
export async function pendingRetry(host, active, since) {
  assert.ok(Number.isSafeInteger(since) && since >= 0);
  const scheduledTime = (Math.floor(since / 60000) + 1) * 60000;
  return waitFor('fixed first occurrence with quiescent persisted retry and snapshot margin', async () => {
    const observed = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    return selectedRetry(observed, scheduledTime, await vmTime(host));
  }, 150000);
}
export async function observeNoReplay(host, active, point, since, phase) {
  const future = await futurePhase(host, active, phase, since), startedAt = await vmTime(host), until = startedAt + 125000;
  let after = future;
  while (await vmTime(host) < until) {
    after = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    noReplay(point.sourceObservation.refresh, after, since - 1);
    assert.ok(after.cronRecords.wakes.every(wake => wake.due_ms > since));
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  after = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
  noReplay(point.sourceObservation.refresh, after, since - 1);
  assert.ok(after.cronRecords.wakes.every(wake => wake.due_ms > since));
  return { future, after, startedAt, endedAt: await vmTime(host) };
}
