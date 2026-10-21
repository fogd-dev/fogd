import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoReplay, skippedDue, assertPausedRoute, assertShutdown } from '../../../scripts/cron-probe/recovery/oracles.mjs';

const before = { attempts: [{ id: 'failed', phase: 'retry-b', scheduled_time: 60000 }], results: [{ job: 'inventory', scheduled_time: 60000 }], occurrences: [{ job: 'inventory', scheduled_time: 60000, attempts: 1 }] };

test('the native recovery oracle catches old retries even when they acquire the new phase or only change idempotency counters', () => {
  const future = structuredClone(before);
  future.attempts.push({ id: 'future', phase: 'after-b', scheduled_time: 180000 });
  assert.doesNotThrow(() => assertNoReplay(before, future, 60000));
  for (const corrupt of [
    rows => { rows.attempts.push({ id: 'replayed', phase: 'after-b', scheduled_time: 60000 }); },
    rows => { rows.results.push({ job: 'advisory', scheduled_time: 60000 }); },
    rows => { rows.occurrences[0].attempts++; },
  ]) {
    const rows = structuredClone(future); corrupt(rows); assert.throws(() => assertNoReplay(before, rows, 60000));
  }
});

test('a due timer is classified skipped only if no old work changed after separate resume', () => {
  const after = structuredClone(before); after.attempts.push({ id: 'future', scheduled_time: 180000 });
  assert.equal(skippedDue(before, after, 120000, 150000).outcome, 'skipped; resume schedules future work');
  after.attempts.push({ id: 'overdue', scheduled_time: 120000 });
  assert.throws(() => skippedDue(before, after, 120000, 150000));
});

test('routing and shutdown oracles reject unrelated failures', () => {
  assert.doesNotThrow(() => assertPausedRoute(503, 'App activation paused'));
  for (const body of ['Routing unavailable', 'No healthy replicas']) assert.throws(() => assertPausedRoute(503, body));
  const stopped = { service: 'controller', running: false, oomKilled: false, restartCount: 0, code: 0 };
  assert.doesNotThrow(() => assertShutdown([stopped, { ...stopped, service: 'workerd', code: 1 }]));
  for (const change of [{ code: 137 }, { restartCount: 1 }, { oomKilled: true }, { running: true }]) assert.throws(() => assertShutdown([{ ...stopped, ...change }]));
});

test('the future-only oracle rejects the latest missed tick even when it is later than the original due timer', () => {
  const after = structuredClone(before); after.attempts.push({ id: 'future', scheduled_time: 240000 });
  assert.doesNotThrow(() => skippedDue(before, after, 120000, 200000));
  after.attempts.push({ id: 'latest-missed-tick', phase: 'after-a', scheduled_time: 180000 });
  assert.throws(() => skippedDue(before, after, 120000, 200000));
});
