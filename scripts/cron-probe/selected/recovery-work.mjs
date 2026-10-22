import assert from 'node:assert/strict';
import { nativeObservation, vmTime } from './observations.mjs';
import { waitFor } from './https.mjs';
import { rows, noReplay } from './recovery-ledger.mjs';

export async function resumeCron(host, active) {
  const requestedAt = await vmTime(host);
  const confirmed = await host.json(['admin', 'dispatch', 'refresh', 'resume', active.id, active.digest]);
  assert.equal(confirmed.observed, 'running'); return { requestedAt, confirmedAt: await vmTime(host), confirmed };
}
export async function armedTimer(host, active) {
  return waitFor('armed future minute with backup margin', async () => {
    const observed = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    return observed.status.paused === false && observed.status.nextAlarm - await vmTime(host) > 25000 && observed;
  }, 150000);
}
export async function futurePhase(host, active, phase, since) {
  return waitFor('autonomous successful refresh phase', async () => {
    const observed = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    const attempts = rows(observed, 'cron_fault_attempts').filter(row => row.phase === phase && row.scheduled_time > since && row.outcome === 'success');
    const occurrences = rows(observed, 'refresh_occurrences'), results = rows(observed, 'refresh_results');
    return ['inventory', 'advisory'].every(job => attempts.some(row => row.job === job &&
      occurrences.some(value => value.job === job && value.scheduled_time === row.scheduled_time && value.status === 'complete') &&
      results.some(value => value.job === job && value.scheduled_time === row.scheduled_time))) && observed;
  }, 180000);
}
export async function pendingRetry(host, active) {
  return waitFor('quiescent persisted retry with snapshot margin', async () => {
    const observed = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    const attempts = rows(observed, 'cron_fault_attempts').filter(row => row.phase === 'retry-b');
    const latest = Math.max(...attempts.map(row => row.scheduled_time));
    const selected = attempts.filter(row => row.scheduled_time === latest);
    if (selected.some(row => row.outcome === 'pending') || selected.filter(row => row.job === 'advisory' && row.outcome === 'thrown').length < 3) return false;
    const wake = observed.cronRecords.wakes.find(row => row.due_ms === observed.status.nextAlarm && row.due_ms > observed.cronRecords.at + 10000 && row.due_ms < latest + 60000);
    return wake && { observed, wake, scheduledTime: latest };
  }, 240000);
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
