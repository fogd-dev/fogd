import assert from 'node:assert/strict';
import { rows, noReplay } from './recovery-ledger.mjs';
import { assertRetryControl } from './failure-retry.mjs';

export function assertFailureHistory(evidence, final) {
  const attempts = rows(final, 'cron_fault_attempts'); assert.ok(attempts.length > 20);
  assert.ok(attempts.every(row => Number.isSafeInteger(row.scheduled_time) && row.scheduled_time > 0 && row.scheduled_time % 60000 === 0 && row.entered_at >= row.scheduled_time && Number.isSafeInteger(row.finished_at) && row.finished_at >= row.entered_at && ['success', 'thrown'].includes(row.outcome) && ['inventory', 'advisory'].includes(row.job)));
  for (const row of attempts) {
    const sparse = ['terminal', 'terminal-future'].includes(row.phase); assert.equal(row.cron, sparse ? '*/3 * * * *' : '* * * * *');
    assert.equal(row.scheduled_time % (sparse ? 180000 : 60000), 0);
  }
  assert.ok(attempts.every(row => row.entered_at < evidence.finalPauseAt));
  for (const interval of evidence.heldIntervals) assert.ok(attempts.every(row => row.entered_at < interval.start || row.entered_at >= interval.end), 'Recorded entry during a required held or preparation interval');
  const phaseRows = (phase, time) => attempts.filter(row => row.phase === phase && row.scheduled_time === time);
  assert.deepEqual(phaseRows('no-retry', evidence.noRetry.first.time), evidence.noRetry.first.attempts);
  assert.deepEqual(phaseRows('no-retry', evidence.noRetry.first.time + 60000), evidence.noRetry.following.attempts);
  assert.deepEqual(phaseRows('terminal', evidence.terminal.first.time), evidence.terminal.attempts);
  assert.deepEqual(phaseRows('downtime', evidence.downtime.due), evidence.downtime.overdue);
  assert.deepEqual(phaseRows('downtime', evidence.downtime.future.time), evidence.downtime.future.attempts);
  assertRetryControl(phaseRows('owner-loss', evidence.ownerLoss.cut.time), evidence.ownerLoss.cut.time);
  for (const before of [evidence.beforeSparse, evidence.beforeMinuteAgain]) {
    const through = Math.max(...rows(before, 'cron_fault_attempts').map(row => row.scheduled_time)); noReplay(before, final, through);
  }
  assert.ok(!attempts.some(row => evidence.downtime.skipped.includes(row.scheduled_time)));
  const results = rows(final, 'refresh_results');
  assert.equal(new Set(results.map(row => JSON.stringify([row.job, row.cron, row.scheduled_time]))).size, results.length);
  for (const [time, expected] of [[evidence.ownerLoss.cut.time, ['advisory', 'inventory']], [evidence.noRetry.first.time, ['inventory']], [evidence.terminal.first.time, ['inventory']], [evidence.downtime.due, ['advisory', 'inventory']], [evidence.browser.first.time, ['inventory']]]) assert.deepEqual(results.filter(row => row.scheduled_time === time).map(row => row.job).sort(), expected);
  return { attempts: attempts.length, results: results.length, heldIntervals: evidence.heldIntervals.length, preservedSnapshots: 2 };
}
