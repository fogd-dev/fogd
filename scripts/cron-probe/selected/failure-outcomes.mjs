import assert from 'node:assert/strict';

export function assertNoRetry(attempts) {
  assert.deepEqual(attempts.map(row => [row.job, row.outcome, row.no_retry_called]).sort(), [['advisory', 'thrown', 1], ['inventory', 'success', 0]]);
}
export function assertCountedTerminal(attempts, time, defaults) {
  assert.ok(Number.isSafeInteger(time) && time > 0 && time % 180000 === 0);
  assert.equal(defaults.alarmRetryCeiling, 6);
  assert.equal(new Set(attempts.map(row => row.id)).size, 12); assert.equal(attempts.length, 12);
  for (const job of ['inventory', 'advisory']) {
    const selected = attempts.filter(row => row.job === job).sort((a, b) => a.entered_at - b.entered_at);
    assert.equal(selected.length, 6);
    for (const [index, row] of selected.entries()) {
      assert.equal(row.cron, '*/3 * * * *'); assert.equal(row.scheduled_time, time); assert.equal(row.no_retry_called, 0);
      assert.equal(row.outcome, job === 'inventory' ? 'success' : 'thrown');
      assert.ok(Number.isSafeInteger(row.entered_at) && Number.isSafeInteger(row.finished_at) && row.entered_at >= time && row.finished_at >= row.entered_at);
      if (index) assert.ok(row.entered_at - selected[index - 1].finished_at >= defaults.alarmBackoffBaseMs * 2 ** index, 'Counted retry entered before its native backoff');
    }
  }
}
