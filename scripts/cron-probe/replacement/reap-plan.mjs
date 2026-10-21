import assert from 'node:assert/strict';

export function reapTick(adoptedAt, at, intervalMs) {
  return adoptedAt + intervalMs * Math.ceil((at - adoptedAt) / intervalMs);
}
export function lateReapPlan({ adoptedAt, scheduledTime, heldRows, intervalMs }) {
  assert.equal(intervalMs, 30000, 'Unqualified native maintenance interval');
  const quietUntil = Math.max(...heldRows.map(row => row.entered_at + 22000), ...heldRows.map(row => row.held_at + 23000));
  const predictedTickAt = reapTick(adoptedAt, quietUntil + 1000, intervalMs);
  const releaseAt = Math.max(scheduledTime + 8000, predictedTickAt - intervalMs + 500);
  assert.ok(releaseAt < scheduledTime + 12000, 'Unqualified reap phase: late cleanup cannot fit before the native operation deadline');
  return { adoptedAt, intervalMs, quietUntil, predictedTickAt, releaseAt };
}
