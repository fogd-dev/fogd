import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReplacementHistory } from './replacement-history.mjs';

function attempt(id, release, job, scheduled_time, outcome = 'success') {
  return { id, release, job, scheduled_time, cron: '* * * * *', entered_at: scheduled_time + 1, finished_at: outcome === 'pending' ? null : scheduled_time + 100, outcome, last_poll_at: scheduled_time + 50 };
}
function result(job, scheduled_time) { return { job, scheduled_time, cron: '* * * * *', saved_at: scheduled_time + 90, value: job + ' saved', compatibility_marker: 'compatible' }; }
function occurrence(job, scheduled_time) { return { job, scheduled_time, cron: '* * * * *', status: job === 'advisory' && scheduled_time === 120000 ? 'pending' : 'complete' }; }
function fixture() {
  const attempts = [attempt('old-a', 'old', 'advisory', 60000), attempt('old-i', 'old', 'inventory', 60000),
    attempt('new-a', 'new', 'advisory', 120000, 'pending'), attempt('new-i', 'new', 'inventory', 120000, 'pending'),
    attempt('retry-a1', 'final', 'advisory', 180000, 'thrown'), attempt('retry-i1', 'final', 'inventory', 180000),
    attempt('retry-a2', 'final', 'advisory', 180000), attempt('retry-i2', 'final', 'inventory', 180000),
    attempt('future-a', 'final', 'advisory', 240000), attempt('future-i', 'final', 'inventory', 240000)];
  const results = [result('advisory', 60000), result('inventory', 60000), result('inventory', 120000), result('advisory', 180000), result('inventory', 180000), result('advisory', 240000), result('inventory', 240000)];
  const occurrences = [occurrence('advisory', 60000), occurrence('inventory', 60000), occurrence('advisory', 120000), occurrence('inventory', 120000), occurrence('advisory', 180000), occurrence('inventory', 180000), occurrence('advisory', 240000), occurrence('inventory', 240000)];
  const final = structuredClone({ attempts, results, occurrences });
  const evidence = { initialLedger: { attempts: [], results: [], occurrences: [] }, finalPauseAt: 250000,
    migration: { oldHeld: { scheduled_time: 60000 }, completed: { attempts: attempts.slice(0, 2), results: results.slice(0, 2), occurrences: occurrences.slice(0, 2) } },
    interruption: { time: 120000, snapshot: attempts.slice(2, 4), afterFree: { attempts: attempts.slice(0, 4), results: results.slice(0, 3), occurrences: occurrences.slice(0, 4) } },
    retry: { time: 180000, completed: { attempts: attempts.slice(0, 8), results: results.slice(0, 5), occurrences: occurrences.slice(0, 6) }, future: { attempts, results, occurrences } },
  };
  return { evidence, final };
}
test('replacement history accepts retained old work, interrupted siblings and idempotent native retries', () => {
  const { evidence, final } = fixture();
  assert.deepEqual(assertReplacementHistory(evidence, final), { attempts: 10, results: 7, occurrences: 8, preservedBaselineAttempts: 0 });
});
for (const [name, alter] of [
  ['an extra callback', value => { value.final.attempts.push({ ...value.final.attempts[0], id: 'extra' }); }],
  ['a duplicate business result', value => { value.final.results.push({ ...value.final.results[0] }); }],
  ['changed abandoned progress', value => { value.final.attempts[2].last_poll_at++; }],
  ['a late callback entry', value => { value.final.attempts[0].entered_at = 250001; value.evidence.migration.completed.attempts[0].entered_at = 250001; }],
  ['an unexplained earlier occurrence', value => { value.final.attempts.push(attempt('unplanned', 'old', 'advisory', 0)); }],
  ['a changed old business value', value => { value.final.results[0].value = 'overwritten'; }],
  ['a changed old business timestamp', value => { value.final.results[0].saved_at++; }],
  ['a changed later healthy result', value => { value.final.results[6].value = 'overwritten'; }],
  ['inventory handled by the wrong release', value => { value.final.attempts[1].release = 'new'; value.evidence.migration.completed.attempts[1].release = 'new'; }],
  ['a changed old occurrence', value => { value.final.occurrences[0].status = 'failed'; }],
  ['an extra saved sibling for interrupted work', value => { value.final.results.push(result('advisory', 120000)); }],
]) test(`replacement history refuses ${name}`, () => {
  const value = fixture(); alter(value); assert.throws(() => assertReplacementHistory(value.evidence, value.final), { code: 'ERR_ASSERTION' });
});

test('baseline result survives a compatible column addition without losing its original fields', () => {
  const { evidence, final } = fixture();
  const baseline = { attempts: [attempt('baseline', 'old', 'inventory', 0)], results: [{ job: 'inventory', scheduled_time: 0, cron: '* * * * *', value: 'original', saved_at: 90 }], occurrences: [occurrence('inventory', 0)] };
  evidence.initialLedger = structuredClone(baseline);
  final.attempts.unshift(baseline.attempts[0]); final.results.unshift({ ...baseline.results[0], compatibility_marker: 'compatible' }); final.occurrences.unshift(baseline.occurrences[0]);
  assert.deepEqual(assertReplacementHistory(evidence, final), { attempts: 11, results: 8, occurrences: 9, preservedBaselineAttempts: 1 });
});
