import assert from 'node:assert/strict';

export function rows(observed, table) {
  return observed.databases.flatMap(database => database.data[table] || []);
}
export function assertRetainedInput(point, pendingInput) {
  const messages = pendingInput.queuePeek.messages;
  assert.equal(messages.length, 1); assert.equal(messages[0].attempts, 0);
  assert.deepEqual(point.queueMessages, messages);
  const original = rows(pendingInput, 'import_jobs').find(row => row.id === 'pending-b');
  assert.equal(original.status, 'accepted'); assert.equal(original.attempts, 0);
  assert.deepEqual(rows(point.sourceObservation.imports, 'import_jobs').find(row => row.id === 'pending-b'), original);
  assert.equal(point.manifest.queueRecovery.apps.imports.observation.backlogCount, 1);
  assert.deepEqual(rows(point.sourceObservation.imports, 'import_results').filter(row => row.job_id === 'pending-b'), []);
}
export function noReplay(before, after, through) {
  for (const table of ['cron_fault_attempts', 'refresh_occurrences', 'refresh_results']) {
    assert.deepEqual(rows(after, table).filter(row => row.scheduled_time <= through), rows(before, table).filter(row => row.scheduled_time <= through), `${table}: old occurrence changed after restored resume`);
  }
}
