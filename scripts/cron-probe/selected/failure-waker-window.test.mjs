import test from 'node:test';
import assert from 'node:assert/strict';
import { preparationWindow } from './failure-waker-window.mjs';

const defaults = { wakerTickMs: 60000, wakerLeaseTtlMs: 180000 };
const at = 1002000, stoppedAt = 1001000;
test('paused preparation accounts for the stopped peer role expiry and a native tick', () => {
  assert.deepEqual(preparationWindow({ at, waker: { node: 'peer', expires_ms: 1170000 } }, 'owner', 'peer', stoppedAt, defaults),
    { eligibleAt: 1170000, deadline: 1250000, ceiling: 1261000, allowanceMs: 20000, initialRole: { node: 'peer', expires_ms: 1170000 } });
});
for (const role of [null, { node: 'owner', expires_ms: 1170000 }]) test(`preparation with ${role ? 'owner-held' : 'absent'} role needs at most a future tick`, () => {
  assert.equal(preparationWindow({ at, waker: role }, 'owner', 'peer', stoppedAt, defaults).deadline, stoppedAt + 80000);
});
for (const [name, role] of [['unknown holder', { node: 'other', expires_ms: 1170000 }], ['excessive TTL', { node: 'peer', expires_ms: 1181001 }]]) test(`paused preparation refuses ${name}`, () => {
  assert.throws(() => preparationWindow({ at, waker: role }, 'owner', 'peer', stoppedAt, defaults));
});

test('an expired role on the live owner is not a valid preparation starting point', () => {
  assert.throws(() => preparationWindow({ at, waker: { node: 'owner', expires_ms: at } }, 'owner', 'peer', stoppedAt, defaults), /expired waker role/);
});
