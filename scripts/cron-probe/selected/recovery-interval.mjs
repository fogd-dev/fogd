import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { recoveredData, applicationData } from './recovery-fixtures.mjs';
import { vmTime } from './observations.mjs';

export async function heldDataInterval(target, { approvals, before, until, verify, beforeRead }) {
  assert.ok(Number.isSafeInteger(until) && until > 0);
  const read = async () => {
    await beforeRead?.();
    const observed = await recoveredData(target, approvals);
    assert.deepEqual(applicationData(observed), before); await verify(observed); return observed;
  };
  while (await vmTime(target) < until) { await read(); await delay(10000); }
  return read();
}
