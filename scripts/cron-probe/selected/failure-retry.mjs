import assert from 'node:assert/strict';

export function retryControlReady(attempts) {
  return !attempts.some(row => row.outcome === 'pending') && ['inventory', 'advisory'].every(job => {
    const selected = attempts.filter(row => row.job === job);
    return selected.length >= 3 && selected.some(row => row.outcome === 'success');
  });
}
export function assertRetryControl(attempts, time) {
  assert.ok(Number.isSafeInteger(time) && time > 0); assert.equal(attempts.length, 6);
  assert.ok(attempts.every(row => row.scheduled_time === time && row.no_retry_called === 0));
  for (const job of ['inventory', 'advisory']) {
    const selected = attempts.filter(row => row.job === job).sort((a, b) => a.entered_at - b.entered_at);
    assert.deepEqual(selected.map(row => row.outcome), job === 'advisory' ? ['thrown', 'thrown', 'success'] : ['success', 'success', 'success']);
    for (const [index, row] of selected.entries()) {
      assert.ok(Number.isSafeInteger(row.entered_at) && Number.isSafeInteger(row.finished_at) && row.entered_at >= time && row.finished_at >= row.entered_at);
      if (index) assert.ok(row.entered_at > selected[index - 1].finished_at, 'Retry entries must follow completed prior attempts');
    }
  }
}
