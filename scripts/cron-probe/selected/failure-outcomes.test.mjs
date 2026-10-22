import test from 'node:test';
import assert from 'node:assert/strict';
import { assertNoRetry, assertCountedTerminal } from './failure-outcomes.mjs';

const defaults = { alarmRetryCeiling: 6, alarmBackoffBaseMs: 2000 };
function counted() {
  return ['inventory', 'advisory'].flatMap(job => [0, 4001, 12002, 28003, 60004, 124005].map((offset, index) => ({ id: `${job}-${index}`, job, cron: '*/3 * * * *', scheduled_time: 180000, entered_at: 180000 + offset, finished_at: 180001 + offset, no_retry_called: 0, outcome: job === 'inventory' ? 'success' : 'thrown' })));
}
test('sparse counted-failure profile accepts six real attempts for each sibling on native backoffs', () => {
  assert.doesNotThrow(() => assertCountedTerminal(counted(), 180000, defaults));
});
for (const [name, alter] of [
  ['a missing attempt', rows => { rows.pop(); }],
  ['a seventh attempt', rows => { rows.push({ ...rows[11], id: 'extra' }); }],
  ['reused attempt identity', rows => { rows[1].id = rows[0].id; }],
  ['noRetry suppression', rows => { rows[6].no_retry_called = 1; }],
  ['a successful advisory result', rows => { rows[6].outcome = 'success'; }],
  ['a retry before its native backoff', rows => { rows[1].entered_at = 184000; }],
  ['a different scheduled occurrence', rows => { rows[6].scheduled_time = 360000; }],
  ['an unfinished attempt', rows => { rows[6].finished_at = null; }],
]) test(`sparse counted-failure profile refuses ${name}`, () => {
  const attempts = counted(); alter(attempts); assert.throws(() => assertCountedTerminal(attempts, 180000, defaults), { code: 'ERR_ASSERTION' });
});
test('noRetry evidence accepts a thrown advisory callback only when native noRetry was called', () => {
  assert.doesNotThrow(() => assertNoRetry([{ job: 'advisory', outcome: 'thrown', no_retry_called: 1 }, { job: 'inventory', outcome: 'success', no_retry_called: 0 }]));
});
test('noRetry evidence refuses an ordinary throw without native suppression', () => {
  assert.throws(() => assertNoRetry([{ job: 'advisory', outcome: 'thrown', no_retry_called: 0 }, { job: 'inventory', outcome: 'success', no_retry_called: 0 }]), { code: 'ERR_ASSERTION' });
});
