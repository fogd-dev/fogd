import assert from 'node:assert/strict';

export function assertPauseUnconfirmed(app, active) {
  assert.equal(app.active, active.id); assert.equal(app.slot, active.slot);
  assert.equal(app.route, 'active'); assert.equal(app.uncertain, null);
  assert.deepEqual(app.dispatch, { ...app.dispatch, desired: 'paused', operation: 'pause', observed: 'unknown', observedAt: null, hold: null, version: active.version });
}
