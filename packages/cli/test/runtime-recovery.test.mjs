import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoveryLayout } from '../src/recovery/layout.mjs';
import { validateTopology, restoredConfig, fingerprint, verifyBundle } from '../src/recovery/bundle.mjs';
import { cronRestoreConfig, sealRuntimeConfig, restoredRuntimeConfig } from '../src/runtime/cron-preboot.mjs';
import { planExpansion } from '../src/recovery/expansion-plan.mjs';
import { runtimeInstallation } from './fixtures/runtime-installation.mjs';
import { config } from './fixtures/recovery-layout.mjs';

test('installation authority is managed independently of the archived data volumes', () => {
  const { source } = runtimeInstallation(), legacy = recoveryLayout(config()), layout = recoveryLayout(source);
  validateTopology(source);
  assert.deepEqual(layout.archiveVolumes, legacy.volumes);
  assert.deepEqual(layout.archives, legacy.archives);
  assert.deepEqual(layout.volumes, [...legacy.volumes, 'runtime-policy'].sort());
  const images = Object.fromEntries(Object.entries(source.services).map(([name, service]) => [name, service.image]));
  const target = restoredConfig(source, 'fresh', images);
  validateTopology(target);
  assert.equal(target.volumes['runtime-policy'].name, 'fresh_runtime-policy');
  assert.equal(source.volumes['runtime-policy'].name, 'original_runtime-policy');
});

test('policy volumes refuse aliases, image seeding, extra writers and mount overrides', () => {
  for (const alter of [
    c => { c.volumes['runtime-policy'].name = 'foreign'; },
    c => { c.volumes.bucket.name = c.volumes['runtime-policy'].name; },
    c => { c.volumes['runtime-policy'].driver_opts = { type: 'none', device: '/private' }; },
    c => { c.volumes['runtime-policy'].external = true; },
    c => { c.services.controller.volumes.at(-1).read_only = false; },
    c => { delete c.services.controller.volumes.at(-1).volume; },
    c => { c.services.controller.volumes.at(-1).volume.nocopy = false; },
    c => { c.services.controller.volumes.at(-1).volume.subpath = 'private'; },
    c => { c.services.controller.volumes.at(-1).target = '/var/lib/fogd'; },
    c => { c.services.controller.volumes.at(-1).bind = {}; },
    c => { c.services.controller.volumes.pop(); },
    c => { c.services.controller.volumes.push(structuredClone(c.services.controller.volumes.at(-1))); },
    c => { c.services['slot-1-a'].volumes.push(structuredClone(c.services.controller.volumes.at(-1))); },
  ]) {
    const { source } = runtimeInstallation(); alter(source);
    assert.throws(() => validateTopology(source), /Runtime policy|volume mapping/);
  }
});

test('policy presence requires independent selection before the first app as well as after retirement', () => {
  const { source, profile } = runtimeInstallation();
  for (const state of [null, { apps: {}, deployments: {} }]) {
    assert.throws(() => cronRestoreConfig(state, source), { code: 'CRON_PREBOOT_REFUSED' });
    assert.deepEqual(cronRestoreConfig(state, source, profile), sealRuntimeConfig(source, profile));
  }
  const sealed = sealRuntimeConfig(source, profile);
  assert.equal(sealed.services.controller.read_only, true);
  assert.equal(sealed.services.controller.build, undefined);
  assert.deepEqual(sealed.services.controller.volumes, source.services.controller.volumes);
  assert.deepEqual(sealRuntimeConfig(sealed, profile), sealed);
  for (const alter of [
    p => { p.family = 'invalid_family'; },
    p => { p.controllerArgs = ['private.mjs']; },
    p => { p.storage.region = 'other'; },
    p => { p.fleets[0].nodes[0].id = 'foreign'; },
  ]) {
    const changed = structuredClone(profile); alter(changed);
    assert.throws(() => sealRuntimeConfig(source, changed), { code: 'CRON_PREBOOT_REFUSED' });
  }
  delete source.volumes['runtime-policy']; source.services.controller.volumes.pop();
  assert.throws(() => sealRuntimeConfig(source, profile), { code: 'CRON_PREBOOT_REFUSED' });
});

test('selected runtime topology cannot expand beyond its two qualified fleets', () => {
  const { source } = runtimeInstallation();
  const images = Object.fromEntries(Object.entries(source.services).map(([name, service]) => [name, service.image]));
  assert.throws(() => planExpansion(source, { apps: {}, deployments: {} }, images), /canonical two-fleet/);
});

test('explicit launch networks must match the independent policy exactly', () => {
  const { source, profile } = runtimeInstallation();
  profile.networks = { control: '10.253.180.0/24', 'fleet-1': '10.253.181.0/24', 'fleet-2': '10.253.182.0/24' };
  for (const [name, subnet] of Object.entries(profile.networks)) source.networks[name].ipam = { config: [{ subnet }] };
  assert.deepEqual(sealRuntimeConfig(source, profile).networks, source.networks);
  source.networks.control.ipam.config[0].subnet = '10.253.183.0/24';
  assert.throws(() => sealRuntimeConfig(source, profile), { code: 'CRON_PREBOOT_REFUSED' });
  delete profile.networks;
  assert.throws(() => sealRuntimeConfig(source, profile), { code: 'CRON_PREBOOT_REFUSED' });
});

test('a selected restore replaces snapshot network placement with independent target selection', () => {
  const { source, profile } = runtimeInstallation();
  for (const [index, network] of Object.values(source.networks).entries()) network.ipam = { config: [{ subnet: `10.252.${180 + index}.0/24` }] };
  const before = structuredClone(source);
  profile.networks = { control: '10.253.180.0/24', 'fleet-1': '10.253.181.0/24', 'fleet-2': '10.253.182.0/24' };
  const target = restoredRuntimeConfig(null, source, profile);
  for (const [name, subnet] of Object.entries(profile.networks)) assert.deepEqual(target.networks[name].ipam, { config: [{ subnet }] });
  assert.deepEqual(source, before);
  delete profile.networks;
  assert.ok(Object.values(restoredRuntimeConfig(null, source, profile).networks).every(network => network.ipam === undefined));
  source.networks.control.driver = 'unqualified';
  assert.throws(() => restoredRuntimeConfig(null, source, profile), { code: 'CRON_PREBOOT_REFUSED' });
});

test('a checksummed snapshot cannot carry runtime authority as a volume archive', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-runtime-bundle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { source } = runtimeInstallation(), files = {};
  for (const name of recoveryLayout(source).archives) {
    await writeFile(join(dir, name), name === 'compose.json' ? JSON.stringify(source) : 'archive');
    files[name] = await fingerprint(join(dir, name));
  }
  const manifest = { format: 'fogd-stopped-v1', files, images: Object.fromEntries(Object.entries(source.services).map(([name, service]) => [name, service.image])) };
  const save = () => writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await save();
  assert.deepEqual((await verifyBundle(dir)).config, source);
  await writeFile(join(dir, 'runtime-policy.tar'), 'forged authority');
  files['runtime-policy.tar'] = await fingerprint(join(dir, 'runtime-policy.tar'));
  await save();
  await assert.rejects(verifyBundle(dir), /volume inventory/);
});
