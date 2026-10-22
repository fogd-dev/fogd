import test from 'node:test';
import assert from 'node:assert/strict';
import { FailureAccess } from './failure-access.mjs';

for (const [name, event] of [
  ['native observer', { kind: 'native', slot: 'slot-1' }],
  ['admin command', { kind: 'cli', command: ['admin', 'dispatch'] }],
  ['application HTTP', { kind: 'http', app: 'refresh', method: 'GET', path: '/' }],
  ['admin HTTP', { kind: 'http', app: null, method: 'GET', path: '/v1/admin' }],
  ['affected replica clock', { kind: 'clock', node: 'slot-1-a' }],
  ['unknown operation', { kind: 'unclassified' }],
]) test(`quiet window refuses ${name}`, () => {
  const access = new FailureAccess('slot-2-a', () => 1000); access.beginQuiet(100);
  assert.throws(() => access.record(event), { code: 'FOGD_QUIET_WINDOW' });
  assert.equal(access.events.at(-1).refused, true);
});
test('quiet window permits storage observations and the outside-fleet clock', () => {
  const access = new FailureAccess('slot-2-a', () => 1000); access.beginQuiet(100);
  access.record({ kind: 'bucket-only' }); access.record({ kind: 'clock', node: 'slot-2-a' });
  assert.deepEqual(access.events, [{ kind: 'quiet-begin', vmAt: 100 }, { kind: 'bucket-only', quiet: true, hostAt: 1000 }, { kind: 'clock', node: 'slot-2-a', quiet: true, hostAt: 1000 }]);
});
test('explicit end of quiet window permits native reads again', () => {
  const access = new FailureAccess('slot-2-a', () => 1000); access.beginQuiet(100); access.endQuiet(200);
  access.record({ kind: 'native', slot: 'slot-1' });
  assert.deepEqual(access.events.at(-1), { kind: 'native', slot: 'slot-1', quiet: false, hostAt: 1000 });
});

for (const method of ['command', 'json']) test(`installed quiet guard blocks ${method} before the shell boundary`, () => {
  let invoked = false;
  const host = { command: () => { invoked = true; }, json: () => { invoked = true; } };
  const access = new FailureAccess('slot-2-a', () => 1000); access.install(host); access.beginQuiet(100);
  assert.throws(() => host[method](['admin', 'dispatch', 'refresh', 'observe']), { code: 'FOGD_QUIET_WINDOW' });
  assert.equal(invoked, false);
});
