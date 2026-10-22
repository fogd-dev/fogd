import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { waitFor } from './https.mjs';

export function completedMinutes(observed, since) {
  const { cron_fault_attempts: attempts, refresh_occurrences: occurrences, refresh_results: results } = observed.data;
  return Object.fromEntries(['inventory', 'advisory'].map(job => [job, attempts.filter(row => row.job === job && row.phase === 'after-a' && row.outcome === 'success' && row.scheduled_time > since &&
    occurrences.some(value => value.job === job && value.scheduled_time === row.scheduled_time && value.status === 'complete') &&
    results.some(value => value.job === job && value.scheduled_time === row.scheduled_time)).map(row => row.scheduled_time)]));
}
export async function continuedWork(reader, options, since, stopped, deadline) {
  return waitFor('future native work while operator pause remains unconfirmed', async () => {
    await stopped(); const observed = await reader.read(options), complete = completedMinutes(observed, since);
    if (observed.completedAt > deadline) throw Object.assign(new Error('Unconfirmed-pause continuation exceeded its fixed native-election window'), { code: 'FOGD_SELECTION_EXPIRED' });
    assert.equal(observed.info.paused, false); assert.ok(Number.isSafeInteger(observed.info.nextAlarm));
    return Object.values(complete).every(times => times.length > 0) && observed;
  }, deadline - since);
}
export async function heldPause(reader, clock) {
  const before = await reader.read(), startedAt = await clock(), until = Math.max(startedAt + 62000, (Math.floor(startedAt / 60000) + 1) * 60000 + 17000);
  assert.equal(before.dispatch.desired, 'paused'); assert.equal(before.dispatch.observed, 'paused'); assert.equal(before.dispatch.operation, null);
  assert.ok(before.data.cron_fault_attempts.every(row => row.outcome !== 'pending'));
  let after = before;
  while (await clock() < until) {
    after = await reader.read(); assert.deepEqual(after.data, before.data); assert.deepEqual(after.dispatch, before.dispatch); assert.equal(after.info.paused, true); assert.equal(after.info.nextAlarm, null);
    await delay(10000);
  }
  after = await reader.read(); assert.deepEqual(after.data, before.data); assert.deepEqual(after.dispatch, before.dispatch); assert.equal(after.info.paused, true); assert.equal(after.info.nextAlarm, null);
  return { before, after, startedAt, endedAt: await clock(), until };
}
