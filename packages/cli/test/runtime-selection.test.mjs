import test from 'node:test';
import assert from 'node:assert/strict';
import { freshRuntimePlan, selectedRuntimeConfig } from '../src/runtime/selection-plan.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

function fixture() {
  const { source, profile } = prebootFixture();
  const entry = { ...profile, id: 'celld-cron-v2-linux-arm64', admission: 'candidate' };
  return { source, entry };
}
test('fresh selection creates distinct native identities, seals images and preserves its input', () => {
  const { source, entry } = fixture(), before = structuredClone(source);
  const first = freshRuntimePlan(source, entry), second = freshRuntimePlan(source, entry);
  assert.deepEqual(source, before);
  assert.notEqual(runtimePolicyIdentity(first.policy), runtimePolicyIdentity(second.policy));
  for (const fleet of first.policy.fleets) for (const node of fleet.nodes) {
    assert.equal(first.config.services[node.host].environment.CELLD_NODE, node.id);
    assert.notEqual(node.id, source.services[node.host].environment.CELLD_NODE);
  }
  assert.deepEqual(selectedRuntimeConfig(first.config, entry, first.policy), first.config);
  assert.equal(first.config.services.controller.build, undefined);
  assert.equal(first.config.services.controller.read_only, true);
  assert.equal(first.config.volumes['runtime-policy'].name, `${source.name}_runtime-policy`);
  const firstRestart = selectedRuntimeConfig(source, entry, first.policy);
  selectedRuntimeConfig(source, entry, second.policy);
  assert.deepEqual(selectedRuntimeConfig(source, entry, first.policy), firstRestart);
});
test('ordinary templates select pinned images and a declared private network placement', () => {
  const { source, entry } = fixture();
  for (const [name, service] of Object.entries(source.services)) service.image = name === 'minio' ? 'fogd-minio:local' : 'fogd-runtime:local';
  for (const [index, network] of Object.values(source.networks).entries()) network.ipam = { config: [{ subnet: `10.253.${180 + index}.0/24` }] };
  const plan = freshRuntimePlan(source, entry);
  assert.deepEqual(plan.policy.networks, { control: '10.253.180.0/24', 'fleet-1': '10.253.181.0/24', 'fleet-2': '10.253.182.0/24' });
  assert.equal(plan.config.services.minio.image, entry.storageImage);
  assert.equal(plan.config.services.controller.image, entry.image);
  assert.equal(plan.config.services['slot-1-a'].environment.CELLD_CLOUD, '0');
});
test('Compose empty IPAM metadata is not an independently chosen network placement', () => {
  const { source, entry } = fixture();
  for (const network of Object.values(source.networks)) network.ipam = {};
  assert.equal(freshRuntimePlan(source, entry).policy.networks, undefined);
  const networks = { control: '10.253.180.0/24', 'fleet-1': '10.253.181.0/24', 'fleet-2': '10.253.182.0/24' };
  const plan = freshRuntimePlan(source, entry, networks);
  for (const [name, subnet] of Object.entries(networks)) assert.deepEqual(plan.config.networks[name].ipam, { config: [{ subnet }] });
});
test('selected launch refuses image drift, reused volumes, changed identities and unsupported timing', () => {
  for (const change of [
    c => { c.services.controller.image = 'mutable:tag'; },
    c => { c.services.minio.image = 'mutable:tag'; },
    c => { c.services['slot-1-a'].environment.CELLD_NODE = 'foreign'; },
    c => { c.services['slot-1-a'].environment.CELLD_TTL_MS = '1'; },
    c => { c.services['slot-1-a'].environment.FOGD_RESTART_DELAY_SECONDS = '1'; },
    c => { c.volumes.bucket.name = c.volumes.controller.name; },
    c => { c.services.controller.environment.NODE_OPTIONS = '--import=/private'; },
  ]) {
    const { source, entry } = fixture(), plan = freshRuntimePlan(source, entry); change(plan.config);
    assert.throws(() => selectedRuntimeConfig(plan.config, entry, plan.policy));
  }
  const { source, entry } = fixture(), plan = freshRuntimePlan(source, entry);
  assert.throws(() => selectedRuntimeConfig(plan.config, { ...entry, id: 'foreign-family' }, plan.policy), /family differs/);
});
