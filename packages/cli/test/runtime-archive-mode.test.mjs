import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeFamily, authorizePolicyEntry, runtimeFamilies, runtimeFamily } from '../src/runtime/catalog.mjs';
import { freshRuntimePlan, selectedRuntimeConfig } from '../src/runtime/selection-plan.mjs';
import { durableRuntimeConfig } from '../src/runtime/durable-config.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';
import { programInventory } from '../src/runtime/program-inventory.mjs';

function fixture() {
  const { source, profile } = prebootFixture();
  const entry = { schema: 3, routing: 'durable', id: 'archive-candidate', admission: 'candidate', os: 'linux', architecture: 'arm64',
    image: profile.image, storageImage: profile.storageImage, binarySha256: profile.binarySha256, supervisorSha256: profile.supervisorSha256,
    parentImage: 'sha256:' + 'e'.repeat(64), sourceFiles: { 'packages/platform/package.json': 'f'.repeat(64),
      'packages/runtime/package.json': '1'.repeat(64), 'packages/platform/src/main-archive.mjs': '2'.repeat(64) } };
  return { source, entry };
}

test('independent archive family seals fresh policy, controller command and durable topology together', () => {
  const { source, entry } = fixture(), before = structuredClone(source), plan = freshRuntimePlan(source, entry);
  assert.deepEqual(source, before);
  assert.equal(plan.policy.schema, 4);
  assert.deepEqual(plan.policy.controllerArgs, ['packages/platform/src/main-archive.mjs']);
  assert.deepEqual(plan.config.services.controller.command, ['packages/platform/src/main-archive.mjs']);
  assert.equal(plan.config.services.workerd.restart, 'no');
  assert.ok(plan.config.volumes['route-authority']);
  assert.deepEqual(validateRuntimeFamily(entry), entry);
  assert.deepEqual(authorizePolicyEntry(plan.policy, entry), entry);
  assert.deepEqual(selectedRuntimeConfig(plan.config, entry, plan.policy), plan.config);
});

test('changing the archive controller command refuses rather than repairing the sealed launch', () => {
  const { source, entry } = fixture(), plan = freshRuntimePlan(source, entry);
  plan.config.services.controller.command = ['packages/platform/src/main-durable.mjs'];
  assert.throws(() => durableRuntimeConfig(plan.config, plan.policy), { code: 'DURABLE_CONFIG_REFUSED' });
});

test('a normal durable family cannot authorize an archive policy with identical native images', () => {
  const { source, entry } = fixture(), plan = freshRuntimePlan(source, entry), ordinary = { ...entry, schema: 2 };
  assert.throws(() => authorizePolicyEntry(plan.policy, ordinary), /differs from the shipped catalog/);
  assert.throws(() => selectedRuntimeConfig(plan.config, ordinary, plan.policy), /differs from installation policy/);
});

test('archive capability requires the fixed entrypoint source and rejects unknown families', () => {
  const { entry } = fixture(); delete entry.sourceFiles['packages/platform/src/main-archive.mjs'];
  assert.throws(() => validateRuntimeFamily(entry), /entrypoint source is missing/);
  assert.throws(() => runtimeFamily('archive-candidate'), /Unknown shipped runtime family/);
});

test('the archive catalog candidate pins current runtime sources while ordinary enrollment stays closed', async () => {
  const candidates = runtimeFamilies().filter(value => value.schema === 3);
  assert.equal(candidates.length, 1);
  const [entry] = candidates;
  assert.equal(entry.id, 'celld-archive-v9-linux-arm64');
  assert.equal(entry.admission, 'candidate');
  assert.throws(() => runtimeFamily(entry.id), /ordinary enrollment remains closed/);
  assert.deepEqual(runtimeFamily(entry.id, 'candidate'), entry);
  assert.deepEqual(entry.sourceFiles, await programInventory(new URL('../../../', import.meta.url).pathname));
});
