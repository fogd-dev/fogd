import assert from 'node:assert/strict';

const scheduledTables = ['attempts', 'results', 'occurrences'];
export function assertNoReplay(before, after, through) {
  for (const table of scheduledTables) assert.deepEqual(after[table].filter(row => row.scheduled_time <= through), before[table].filter(row => row.scheduled_time <= through), `${table}: restored resume changed an old occurrence`);
}
export function skippedDue(before, after, due, resumeAt) {
  assert.ok(Number.isSafeInteger(due));
  assert.equal(before.attempts.filter(row => row.scheduled_time === due).length, 0, 'The selected due timer must not have executed before snapshot');
  assert.ok(Number.isSafeInteger(resumeAt) && resumeAt > due);
  assertNoReplay(before, after, resumeAt - 1);
  return { scheduledTime: due, resumeRequestedAt: resumeAt, outcome: 'skipped; resume schedules future work' };
}
export function assertPausedRoute(status, body) {
  assert.equal(status, 503); assert.equal(body, 'App activation paused');
}
export function assertShutdown(exits) {
  for (const exit of exits) {
    assert.equal(exit.running, false, `${exit.service} is still running`);
    assert.equal(exit.restartCount, 0, `${exit.service} restarted during qualification`);
    assert.equal(exit.oomKilled, false, `${exit.service} was OOM-killed`);
    // serve.mjs maps a signaled workerd child (null code) to exit 1.
    assert.ok((exit.service === 'workerd' ? [0, 1] : [0]).includes(exit.code), `${exit.service} had unexpected exit ${exit.code}`);
  }
}
