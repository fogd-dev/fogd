import test from 'node:test';
import assert from 'node:assert/strict';
import { planRetirement } from '../src/recovery/retirement-plan.mjs';
import { composeLiteral, composeResolved } from '../src/recovery/bundle.mjs';

const digest = 'a'.repeat(64), id = '00000000-0000-4000-8000-000000000001';
function fixture() {
  const slots = [1, 2].map(n => ({ id: `slot-${n}`, prefix: `slots/${n}`, nodes: [`slot-${n}-a`, `slot-${n}-b`] }));
  const config = { services: { controller: { environment: { FOGD_SLOTS: JSON.stringify(slots), FOGD_BUCKET: 'bucket', PRIVATE: 'literal$VALUE' } }, workerd: { environment: { FOGD_SLOTS: JSON.stringify(slots) } } } };
  for (const slot of slots) for (const name of slot.nodes) config.services[name] = { environment: { CELLD_BUCKET: `s3://bucket/${slot.prefix}`, CELLD_NODE: name, PRIVATE: 'literal$VALUE' }, command: ['unchanged'] };
  const state = { apps: { notebook: { slot: 'slot-2', active: 'release', route: 'active' } }, deployments: { release: { app: 'notebook', status: 'active', digest } } };
  return { config, state };
}
test('retirement changes only one fleet namespace and identities and skips only its replica archives', () => {
  const { config, state } = fixture(), before = structuredClone(config);
  const plan = planRetirement(config, state, 'notebook', digest, { id });
  assert.deepEqual(config, before);
  assert.deepEqual(plan.skipped, ['slot-2-a', 'slot-2-b']);
  for (const name of ['slot-1-a', 'slot-1-b']) assert.deepEqual(plan.config.services[name], config.services[name]);
  for (const name of plan.skipped) {
    assert.equal(plan.config.services[name].environment.CELLD_NODE, `${name}-${id}`);
    assert.equal(plan.config.services[name].environment.CELLD_BUCKET, `s3://bucket/retirement-generations/${id}`);
    assert.equal(plan.config.services[name].environment.PRIVATE, 'literal$VALUE');
    assert.deepEqual(plan.config.services[name].command, config.services[name].command);
  }
  assert.equal(plan.config.services.controller.environment.PRIVATE, 'literal$VALUE');
  assert.deepEqual(composeResolved(composeLiteral(plan.config)), plan.config);
  assert.equal(plan.state.apps.notebook.retirement.previous.prefix, 'slots/2');
});
test('retirement rejects divergent routing or replica bucket settings', () => {
  const a = fixture(); a.config.services.workerd.environment.FOGD_SLOTS = '[]';
  assert.throws(() => planRetirement(a.config, a.state, 'notebook', digest), /configuration differs/);
  const b = fixture(); b.config.services['slot-2-a'].environment.CELLD_BUCKET = 's3://foreign/bucket';
  assert.throws(() => planRetirement(b.config, b.state, 'notebook', digest), /bucket differs/);
});

test('retirement rejects overlapping historical generations and malformed tombstones', () => {
  const { config, state } = fixture();
  state.requirements = ['fogd-retirement-v1'];
  state.apps.old = { slot: null, route: 'retired', retirement: { previous: { prefix: `retirement-generations/${id}` } } };
  assert.throws(() => planRetirement(config, state, 'notebook', digest, { id }), /overlaps retained/);
  state.apps.old.slot = 'slot-1';
  assert.throws(() => planRetirement(config, state, 'notebook', digest, { id }), /Invalid retirement tombstone/);
  state.apps.old.slot = null; state.apps.old.route = 'active';
  assert.throws(() => planRetirement(config, state, 'notebook', digest, { id }), /Invalid retirement tombstone/);
});
