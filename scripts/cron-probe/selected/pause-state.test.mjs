import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPauseUnconfirmed } from './pause-state.mjs';

const active = { id: 'approved-release', slot: 'slot-1', version: 'approved-version' };
function pendingPause() {
  return { active: 'approved-release', slot: 'slot-1', route: 'active', uncertain: null,
    dispatch: { desired: 'paused', operation: 'pause', observed: 'unknown', observedAt: null, hold: null, version: 'approved-version' } };
}
test('an unconfirmed operator pause preserves the active route and pending intent evidence', () => {
  const value = pendingPause(), before = structuredClone(value);
  assertPauseUnconfirmed(value, active);
  assert.deepEqual(value, before);
});
for (const [name, change] of [
  ['another approval', value => { value.active = 'other-release'; }],
  ['another fleet', value => { value.slot = 'slot-2'; }],
  ['a routing pause', value => { value.route = 'paused'; }],
  ['migration uncertainty', value => { value.uncertain = 'migration'; }],
  ['running intent', value => { value.dispatch.desired = 'running'; }],
  ['a completed operation', value => { value.dispatch.operation = null; }],
  ['an optimistic paused observation', value => { value.dispatch.observed = 'paused'; }],
  ['a retained observation timestamp', value => { value.dispatch.observedAt = '2026-01-01T00:00:00Z'; }],
  ['an activation hold', value => { value.dispatch.hold = 'held-release'; }],
  ['another native version', value => { value.dispatch.version = 'other-version'; }],
]) test(`unconfirmed pause evidence refuses ${name}`, () => {
  const value = pendingPause(); change(value);
  assert.throws(() => assertPauseUnconfirmed(value, active), { code: 'ERR_ASSERTION' });
});
