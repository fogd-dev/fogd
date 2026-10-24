import test from 'node:test';
import assert from 'node:assert/strict';
import { observationSelection, observationReport } from '../src/observe/model.mjs';
import { observationKey } from '../src/observe/fingerprint.mjs';
import { supportedController } from '../src/controller-schema.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';
import { freshRuntimePlan } from '../src/runtime/selection-plan.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { routeAuthorityCapability } from '@fogd/platform/route-snapshot';
const id = '00000000-0000-4000-8000-000000000001', digest = 'a'.repeat(64);
function fixture() {
  const { source, profile } = prebootFixture();
  const { policy } = freshRuntimePlan(source, { ...profile, schema: 2, id: 'test-durable', admission: 'candidate', routing: 'durable' }, undefined, id);
  return { policy, state: { requirements: [routeAuthorityCapability], apps: { sample: { route: 'active', active: id, slot: 'slot-1' } },
    deployments: { [id]: { id, app: 'sample', digest, status: 'active', step: 'complete', version: 'version' } },
    routeAuthority: { schema: 1, installation: runtimePolicyIdentity(policy), holds: {}, settled: { revision: '1', digest }, pending: null } } };
}
test('diagnostics recognize durable metadata without broadening generic controller support', () => {
  const { state, policy } = fixture();
  assert.equal(observationSelection(state, 'sample', policy).reason, null);
  assert.equal(supportedController(state), false);
});
for (const mode of ['hold', 'pending']) test(`durable ${mode} cannot be promoted by healthy native replicas`, () => {
  const { state, policy } = fixture();
  if (mode === 'hold') state.routeAuthority.holds.sample = { id, digest };
  else state.routeAuthority.pending = { kind: 'active' };
  const selection = observationSelection(state, 'sample', policy);
  assert.equal(selection.reason, 'http-routing-unconfirmed');
  const context = { installation: 'local', boundary: 'matched-at-boundaries', controllerProcess: 'running-at-boundaries', observedAt: '2026-10-24T00:00:00Z' };
  const replicas = policy.fleets[0].nodes.map(node => ({ node: node.host, stateHTTPStatus: 200, healthHTTPStatus: 200, version: 'matches' }));
  assert.equal(observationReport(selection, context, { identity: 'verified', leases: 'current', replicas }).nativeReadiness, 'uncertain');
});
for (const [name, change] of [
  ['future requirement', s => { s.requirements.push('future-protocol'); }],
  ['missing durable capability', s => { s.requirements = []; }],
  ['missing requirements', s => { delete s.requirements; }],
  ['missing journal', s => { delete s.routeAuthority; }],
  ['foreign installation', s => { s.routeAuthority.installation = 'f'.repeat(64); }],
  ['future journal schema', s => { s.routeAuthority.schema = 2; }],
  ['missing pending field', s => { delete s.routeAuthority.pending; }],
  ['unknown journal field', s => { s.routeAuthority.future = true; }],
  ['non-object holds', s => { s.routeAuthority.holds = []; }],
  ['primitive pending', s => { s.routeAuthority.pending = true; }],
  ['primitive settled', s => { s.routeAuthority.settled = 'unknown'; }],
]) test(`unsupported durable metadata refuses diagnostic selection: ${name}`, () => {
  const { state, policy } = fixture(); change(state);
  assert.throws(() => observationSelection(state, 'sample', policy), /unsupported/);
});
test('route journal changes invalidate the diagnostic observation boundary', () => {
  const { state } = fixture(), before = observationKey(state, 'sample');
  state.routeAuthority.pending = { kind: 'active' };
  assert.notEqual(observationKey(state, 'sample'), before);
});

test('a durable HTTP hold permits native inspection without permitting a gateway request', () => {
  const { state, policy } = fixture(); state.routeAuthority.holds.sample = { id, digest };
  state.apps.sample.route = 'paused';
  const selection = observationSelection(state, 'sample', policy);
  assert.equal(selection.reason, 'http-routing-unconfirmed');
  assert.equal(selection.expected?.slot, 'slot-1');
});
test('pending durable publication still prevents native sampling', () => {
  const { state, policy } = fixture(); state.routeAuthority.pending = { kind: 'active' };
  const selection = observationSelection(state, 'sample', policy);
  assert.equal(selection.reason, 'http-routing-unconfirmed');
  assert.equal(selection.expected, undefined);
});
