import test from 'node:test';
import assert from 'node:assert/strict';
import { lateReapPlan, reapTick } from './reap-plan.mjs';

test('an early adoption phase schedules publication after the old tick and cleanup after the quiet check', () => {
  assert.deepEqual(lateReapPlan({ adoptedAt: 2000, scheduledTime: 60000, heldRows: [{ entered_at: 60010, held_at: 60200 }], intervalMs: 30000 }),
    { adoptedAt: 2000, intervalMs: 30000, quietUntil: 83200, predictedTickAt: 92000, releaseAt: 68000 });
});
test('a later eligible phase waits past its measured tick while retaining publication margin', () => {
  assert.deepEqual(lateReapPlan({ adoptedAt: 11000, scheduledTime: 60000, heldRows: [{ entered_at: 60010, held_at: 60200 }], intervalMs: 30000 }),
    { adoptedAt: 11000, intervalMs: 30000, quietUntil: 83200, predictedTickAt: 101000, releaseAt: 71500 });
});
test('a maintenance phase outside the publication window is refused before release', () => {
  assert.throws(() => lateReapPlan({ adoptedAt: 18000, scheduledTime: 60000, heldRows: [{ entered_at: 60010, held_at: 60200 }], intervalMs: 30000 }), /Unqualified reap phase/);
});
test('the next maintenance tick includes an exact boundary', () => {
  assert.equal(reapTick(2000, 92000, 30000), 92000);
});
test('a different native maintenance interval is refused', () => {
  assert.throws(() => lateReapPlan({ adoptedAt: 2000, scheduledTime: 60000, heldRows: [{ entered_at: 60010, held_at: 60200 }], intervalMs: 15000 }), /Unqualified native maintenance interval/);
});
