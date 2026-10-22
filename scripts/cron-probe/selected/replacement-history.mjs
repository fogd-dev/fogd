import assert from 'node:assert/strict';

export function assertReplacementHistory(evidence, final) {
  const phases = [[evidence.migration.oldHeld.scheduled_time, 1, ['advisory', 'inventory'], 'old'], [evidence.interruption.time, 1, ['inventory'], 'new'],
    [evidence.retry.time, 2, ['advisory', 'inventory'], 'final'], [evidence.retry.time + 60000, 1, ['advisory', 'inventory'], 'final']];
  assert.equal(new Set(phases.map(([time]) => time)).size, 4);
  for (const [time, count, jobs, release] of phases) {
    for (const job of ['advisory', 'inventory']) {
      const attempts = final.attempts.filter(row => row.scheduled_time === time && row.job === job); assert.equal(attempts.length, count);
      assert.ok(attempts.every(row => row.release === release));
    }
    assert.deepEqual(final.results.filter(row => row.scheduled_time === time).map(row => row.job).sort(), jobs);
  }
  for (const table of ['attempts', 'results', 'occurrences']) {
    const baseline = evidence.initialLedger[table], retained = final[table].filter(row => !phases.some(([time]) => time === row.scheduled_time));
    assert.equal(retained.length, baseline.length);
    for (const old of baseline) {
      const current = retained.find(row => table === 'attempts' ? row.id === old.id : row.job === old.job && row.cron === old.cron && row.scheduled_time === old.scheduled_time);
      assert.ok(current); for (const [key, value] of Object.entries(old)) assert.deepEqual(current[key], value);
    }
    for (const snapshot of [evidence.migration.completed, evidence.interruption.afterFree, evidence.retry.completed, evidence.retry.future]) {
      for (const old of snapshot[table]) {
        const current = final[table].find(row => table === 'attempts' ? row.id === old.id : row.job === old.job && row.cron === old.cron && row.scheduled_time === old.scheduled_time);
        assert.deepEqual(current, old, `${table}: prior row changed after approval or later work`);
      }
    }
  }
  const abandoned = evidence.interruption.snapshot;
  for (const old of abandoned) assert.deepEqual(final.attempts.find(row => row.id === old.id), old);
  for (const row of final.attempts) {
    assert.ok(Number.isSafeInteger(row.scheduled_time) && row.scheduled_time % 60000 === 0 && row.cron === '* * * * *');
    assert.ok(row.entered_at >= row.scheduled_time && row.entered_at < evidence.finalPauseAt);
    if (!abandoned.some(old => old.id === row.id)) assert.ok(['success', 'thrown'].includes(row.outcome) && Number.isSafeInteger(row.finished_at));
  }
  assert.equal(new Set(final.attempts.map(row => row.id)).size, final.attempts.length);
  assert.equal(new Set(final.results.map(row => JSON.stringify([row.job, row.cron, row.scheduled_time]))).size, final.results.length);
  return { attempts: final.attempts.length, results: final.results.length, occurrences: final.occurrences.length, preservedBaselineAttempts: evidence.initialLedger.attempts.length };
}
