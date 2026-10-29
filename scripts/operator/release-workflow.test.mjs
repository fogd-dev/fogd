import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { routingView } from '../../packages/cli/src/routing/view.mjs';
import { receivedReplicaReadiness } from './release-readiness.mjs';

test.beforeEach(t => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 }));

const active = { id: '9084ffd1-a5b9-404a-9059-ad05c34b6848', digest: 'a'.repeat(64) };
const raw = { app: 'baseline', state: 'withheld', revision: '1', active: null, hold: active, startupBlocked: false, pending: null };
const ready = { nativeReadiness: 'uncertain', reason: 'http-routing-unconfirmed', runtimeIdentity: 'verified', runtimeLeases: 'current',
  replicas: ['slot-1-a', 'slot-1-b'].map(node => ({ node, stateHTTPStatus: 200, healthHTTPStatus: 200, version: 'matches' })) };

function observedHost(samples) {
  const calls = []; let index = 0;
  return { project: 'retained-target', calls, async json(args) {
    calls.push(args);
    if (args[0] === 'observe') { assert.deepEqual(args, ['observe', 'baseline', '--installation', 'retained-target']); return samples[index].report; }
    assert.deepEqual(args, ['admin', 'routing', 'baseline', 'status'], 'Readiness must never mutate routing');
    return routingView(samples[index++].routing, 'baseline');
  } };
}

test('readiness consumes the normalized public CLI hold while HTTP remains withheld', async () => {
  const host = observedHost([{ report: ready, routing: raw }]), record = {};
  const selected = await receivedReplicaReadiness(host, 'baseline', active, record);
  assert.deepEqual(selected.hold, { deployment: active.id, digest: active.digest });
  assert.equal(selected.state, 'withheld'); assert.equal(record.samples[0].report.nativeReadiness, 'uncertain'); assert.equal(host.calls.length, 2);
});

test('expired native leases require a fresh observation before the next decision', async t => {
  const host = observedHost([{ report: { ...ready, runtimeLeases: 'expired' }, routing: raw }, { report: ready, routing: raw }]), record = {};
  const pending = receivedReplicaReadiness(host, 'baseline', active, record);
  await nextTurn(); t.mock.timers.runAll(); await pending;
  assert.equal(record.samples.length, 2); assert.equal(record.samples[0].report.runtimeLeases, 'expired'); assert.equal(record.samples[1].report.runtimeLeases, 'current');
});

test('verified replicas do not bypass unfinished controller startup', async t => {
  const host = observedHost([{ report: ready, routing: { ...raw, startupBlocked: true } }, { report: ready, routing: raw }]), record = {};
  const pending = receivedReplicaReadiness(host, 'baseline', active, record);
  await nextTurn(); t.mock.timers.runAll(); const selected = await pending;
  assert.equal(record.samples.length, 2); assert.equal(selected.startupBlocked, false);
});

for (const [name, routing] of [
  ['another held deployment', { ...raw, hold: { ...active, id: '026d4fa4-3eb3-4730-9a9e-4aa7bd220c0e' } }],
  ['another held digest', { ...raw, hold: { ...active, digest: 'b'.repeat(64) } }],
  ['a route already active before the decision', { ...raw, state: 'active', active: { deployment: active.id, digest: active.digest }, hold: null }],
]) test(`readiness stops immediately for ${name}`, async () => {
  const host = observedHost([{ report: ready, routing }]), record = {};
  await assert.rejects(receivedReplicaReadiness(host, 'baseline', active, record), { code: 'FOGD_SELECTION_EXPIRED' });
  assert.equal(record.samples.length, 1); assert.equal(host.calls.length, 2);
});
