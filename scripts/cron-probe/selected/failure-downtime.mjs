import assert from 'node:assert/strict';

export function assertAutonomousWake(sample, due, restartAt, firstReadAt) {
  assert.equal(sample.authorityDeferred, true);
  const expected = (Math.floor(firstReadAt / 60000) + 1) * 60000;
  const future = sample.bucket.wakes.find(row => row.due_ms === expected && Number.isSafeInteger(row.keyLastModifiedMs) && row.keyLastModifiedMs >= restartAt && row.keyLastModifiedMs < firstReadAt - 1000);
  assert.ok(future, 'Next natural minute wake was not persisted before the first native request'); assert.notEqual(future.due_ms, due); return future;
}
export function assertAutonomousDowntime(evidence) {
  const { due, downAt, restartRequestedAt, replicasStartedAt, firstReadAt, firstRead } = evidence;
  for (const value of [due, downAt, restartRequestedAt, replicasStartedAt, firstReadAt]) assert.ok(Number.isSafeInteger(value) && value > 0);
  assert.ok(Number.isSafeInteger(due) && due % 60000 === 0 && downAt < due && restartRequestedAt >= due + 122000);
  assert.ok(replicasStartedAt >= restartRequestedAt && firstReadAt >= replicasStartedAt + 45000);
  const future = assertAutonomousWake(evidence.autonomousWake, due, restartRequestedAt, firstReadAt);
  assert.ok(evidence.autonomousWake.startedAt >= replicasStartedAt && evidence.autonomousWake.completedAt >= evidence.autonomousWake.startedAt && evidence.autonomousWake.completedAt <= firstReadAt);
  assert.ok(firstRead.startedAt >= firstReadAt && firstRead.completedAt >= firstRead.startedAt);
  assert.equal(firstRead.authorityDeferred, true); assert.equal(firstRead.ledger, 'available');
  const overdue = firstRead.rows.filter(row => row.scheduled_time === due);
  assert.deepEqual(overdue.map(row => [row.job, row.outcome, row.no_retry_called]).sort(), [['advisory', 'success', 0], ['inventory', 'success', 0]]);
  assert.ok(overdue.every(row => row.cron === '* * * * *' && Number.isSafeInteger(row.entered_at) && Number.isSafeInteger(row.finished_at) && row.entered_at >= restartRequestedAt && row.entered_at < firstReadAt && row.finished_at >= row.entered_at && row.finished_at < firstReadAt));
  const skipped = []; for (let time = due + 60000; time < restartRequestedAt; time += 60000) skipped.push(time);
  assert.ok(skipped.length >= 2); assert.ok(!firstRead.rows.some(row => skipped.includes(row.scheduled_time)));
  assert.ok(!firstRead.rows.some(row => row.entered_at >= downAt && row.entered_at < restartRequestedAt));
  return { overdue, skipped, futureDue: future.due_ms, otherWakeHints: evidence.autonomousWake.bucket.wakes.filter(row => row !== future) };
}
