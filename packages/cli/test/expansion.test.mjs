import test from 'node:test';
import assert from 'node:assert/strict';
import { config, services } from './fixtures/recovery-layout.mjs';
import { planExpansion } from '../src/recovery/expansion-plan.mjs';
import { validateTopology, restoredConfig } from '../src/recovery/bundle.mjs';
import { recoveryLayout } from '../src/recovery/layout.mjs';
const id = '00000000-0000-4000-8000-000000000003';
const images = Object.fromEntries(services.map(name => [name, 'sha256:' + 'b'.repeat(64)]));

test('expansion preserves existing apps and replicas while adding empty pinned capacity', () => {
  const source = config(), state = { apps: {}, deployments: {} }, before = structuredClone({ source, state, images });
  const plan = planExpansion(source, state, images, { id });
  assert.deepEqual({ source, state, images }, before);
  for (const name of ['slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b']) assert.deepEqual(plan.config.services[name], source.services[name]);
  assert.deepEqual(plan.skipped, ['slot-3-a', 'slot-3-b']);
  assert.equal(plan.config.services['slot-3-a'].environment.CELLD_BUCKET, `s3://fogd/expansion-generations/${id}`);
  assert.equal(plan.config.services['slot-3-a'].environment.CELLD_NODE, `slot-3-a-${id}`);
  assert.equal(plan.config.services.controller.environment.TOKEN, source.services.controller.environment.TOKEN);
  assert.deepEqual(Object.keys(plan.config.volumes).sort(), [...Object.keys(source.volumes), ...plan.skipped].sort());
  validateTopology(plan.config);
  const restored = restoredConfig(plan.config, 'expanded', plan.images);
  assert.equal(restored.services['slot-3-a'].image, images['slot-2-a']);
  assert.equal(restored.volumes['slot-3-a'].name, 'expanded_slot-3-a');
  assert.equal(recoveryLayout(restored).services.length, 10);
  assert.equal(recoveryLayout(restored).archives.length, 10);
  assert.throws(() => planExpansion(plan.config, state, plan.images), /two-fleet source/);
});
test('expansion refuses retained namespaces and identity collisions', () => {
  const source = config();
  const state = { requirements: ['fogd-retirement-v1'], apps: { retired: { route: 'retired', slot: null, retirement: { previous: { prefix: `expansion-generations/${id}` } } } } };
  assert.throws(() => planExpansion(source, state, images, { id }), /overlaps retained storage/);
  source.services['slot-1-a'].environment.CELLD_NODE = `slot-3-a-${id}`;
  assert.throws(() => planExpansion(source, { apps: {} }, images, { id }), /Replica identities/);
});
