import test from 'node:test';
import assert from 'node:assert/strict';
import { retireState, retirementApp, validateRetirementState } from '../src/retirement.mjs';

const digest = 'a'.repeat(64);
const evidence = { id: 'generation', previous: { slot: 'slot-1', prefix: 'slots/one', nodes: ['a', 'b'] }, replacement: { prefix: 'generation/new', nodes: ['new-a', 'new-b'] } };
const fixture = () => ({ apps: { notebook: { slot: 'slot-1', route: 'active', active: 'active' }, accounts: { slot: 'slot-2', route: 'active' } }, deployments: {
  active: { app: 'notebook', digest, status: 'active' }, pending: { app: 'notebook', status: 'pending' }, failed: { app: 'notebook', status: 'failed' }, other: { app: 'accounts', status: 'pending' }, rejected: { app: 'notebook', status: 'rejected' },
} });
test('retirement preserves history and the other app while permanently removing slot assignment', () => {
  const state = fixture(), before = structuredClone(state);
  const next = retireState(state, 'notebook', digest, evidence);
  assert.deepEqual(state, before);
  assert.equal(next.apps.notebook.slot, null);
  assert.equal(next.apps.notebook.route, 'retired');
  assert.equal(next.apps.notebook.retirement.digest, digest);
  assert.deepEqual(next.apps.accounts, state.apps.accounts);
  for (const id of ['active', 'pending', 'failed']) assert.equal(next.deployments[id].status, 'retired');
  assert.equal(next.deployments.other.status, 'pending');
  assert.equal(next.deployments.rejected.status, 'rejected');
  validateRetirementState(next, [{ prefix: 'generation/new' }, { prefix: 'slots/two' }]);
  for (const prefix of ['slots/one', 'slots/one/child', 'slots']) assert.throws(() => validateRetirementState(next, [{ prefix }]), /overlaps/);
  assert.throws(() => retireState(next, 'notebook', digest, evidence), /permanently retired/);
});
test('retirement refuses ambiguous or unmatched active state before transforming anything', () => {
  assert.throws(() => retirementApp(fixture(), 'missing', digest), /existing activated/);
  assert.throws(() => retirementApp(fixture(), 'notebook', 'b'.repeat(64)), /digest mismatch/);
  for (const patch of [{ quarantined: true }, { uncertain: 'failed' }, { route: 'unknown' }, { active: null }]) {
    const state = fixture(); Object.assign(state.apps.notebook, patch);
    assert.throws(() => retirementApp(state, 'notebook', digest), /active|activated/);
  }
  const paused = fixture(); paused.apps.notebook.route = 'paused';
  assert.equal(retireState(paused, 'notebook', digest, evidence).apps.notebook.route, 'retired');
  const state = fixture(); state.deployments.pending.status = 'activating';
  assert.throws(() => retirementApp(state, 'notebook', digest), /interrupted activation/);
});
