import test from 'node:test';
import assert from 'node:assert/strict';
import { completedMinutes } from './pause-work.mjs';

function committed() {
  return { data: {
    cron_fault_attempts: [
      { job: 'inventory', phase: 'after-a', outcome: 'success', scheduled_time: 120000 },
      { job: 'advisory', phase: 'after-a', outcome: 'success', scheduled_time: 120000 },
    ],
    refresh_occurrences: [
      { job: 'inventory', status: 'complete', scheduled_time: 120000 },
      { job: 'advisory', status: 'complete', scheduled_time: 120000 },
    ],
    refresh_results: [{ job: 'inventory', scheduled_time: 120000 }, { job: 'advisory', scheduled_time: 120000 }],
  } };
}
test('continued-work evidence joins both jobs to their completed occurrence and saved result after the cutoff', () => {
  assert.deepEqual(completedMinutes(committed(), 119999), { inventory: [120000], advisory: [120000] });
});
test('a minute at the cutoff cannot qualify as later native work', () => {
  assert.deepEqual(completedMinutes(committed(), 120000), { inventory: [], advisory: [] });
});
for (const [name, change] of [
  ['a missing saved result', value => { value.data.refresh_results.pop(); }],
  ['an unfinished occurrence', value => { value.data.refresh_occurrences[1].status = 'pending'; }],
  ['a failed attempt', value => { value.data.cron_fault_attempts[1].outcome = 'thrown'; }],
  ['another diagnostic phase', value => { value.data.cron_fault_attempts[1].phase = 'snapshot-a'; }],
]) test(`continued-work evidence excludes ${name}`, () => {
  const value = committed(); change(value);
  assert.deepEqual(completedMinutes(value, 119999), { inventory: [120000], advisory: [] });
});
