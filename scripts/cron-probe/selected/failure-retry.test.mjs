import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRetryControl, retryControlReady } from './failure-retry.mjs';

const attempts = () => [
  { job: 'inventory', scheduled_time: 1000, entered_at: 1000, finished_at: 1010, outcome: 'success', no_retry_called: 0 },
  { job: 'advisory', scheduled_time: 1000, entered_at: 1000, finished_at: 1010, outcome: 'thrown', no_retry_called: 0 },
  { job: 'inventory', scheduled_time: 1000, entered_at: 5020, finished_at: 5030, outcome: 'success', no_retry_called: 0 },
  { job: 'advisory', scheduled_time: 1000, entered_at: 5020, finished_at: 5030, outcome: 'thrown', no_retry_called: 0 },
  { job: 'inventory', scheduled_time: 1000, entered_at: 13040, finished_at: 13050, outcome: 'success', no_retry_called: 0 },
  { job: 'advisory', scheduled_time: 1000, entered_at: 13040, finished_at: 13050, outcome: 'success', no_retry_called: 0 },
];
test('the retry positive control waits for the third inventory entry', () => {
  const rows = attempts(); rows.splice(4, 1);
  assert.equal(retryControlReady(rows), false);
});
test('the retry positive control recognizes both settled job sequences', () => {
  assert.equal(retryControlReady(attempts()), true);
});
for (const [name, mutate] of [
  ['concurrent dispatch', rows => { rows[3].entered_at = 1000; }],
  ['success before the final throw', rows => { rows[1].outcome = 'success'; rows[5].outcome = 'thrown'; }],
  ['a different occurrence', rows => { rows[5].scheduled_time = 2000; }],
  ['retry suppression', rows => { rows[1].no_retry_called = 1; }],
]) test(`the retry positive control rejects ${name}`, () => {
  const rows = attempts(); mutate(rows);
  assert.throws(() => assertRetryControl(rows, 1000), assert.AssertionError);
});
test('the retry positive control accepts serialized throws followed by success', () => {
  assert.doesNotThrow(() => assertRetryControl(attempts(), 1000));
});
