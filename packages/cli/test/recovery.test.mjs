import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, verifyBundle, readJson, restoredConfig, composeLiteral, composeResolved, validateTopology } from '../src/recovery/bundle.mjs';
import { projectName } from '../src/recovery/docker.mjs';

const replicas = ['slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b'];
const services = ['bucket-init', 'controller', 'minio', ...replicas, 'workerd'];
const volumes = ['bucket', 'controller', ...replicas];
const slots = [1, 2].map(n => ({ id: `slot-${n}`, prefix: `slots/slot-${n}`, nodes: [`slot-${n}-a`, `slot-${n}-b`] }));
function config() {
  const shared = { control: {}, 'fleet-1': {}, 'fleet-2': {} };
  const result = { name: 'original', services: Object.fromEntries(services.map(name => [name, { image: 'mutable:tag', build: '.', environment: { FOGD_BUCKET: 'fogd', FOGD_SLOTS: JSON.stringify(slots), S3_ENDPOINT: 'http://minio:9000', TOKEN: 'literal$VALUE${HOME}' }, networks: shared }])), volumes: Object.fromEntries(volumes.map(name => [name, { name: `original_${name}` }])), networks: Object.fromEntries(Object.keys(shared).map(name => [name, { name: `original_${name}` }])) };
  result.services['bucket-init'].networks = { control: {} };
  for (const name of replicas) {
    const slot = name.slice(0, -2);
    Object.assign(result.services[name].environment, { CELLD_NODE: name, CELLD_BUCKET: `s3://fogd/slots/${slot}` });
    result.services[name].networks = { [`fleet-${slot.slice(5)}`]: {} };
    result.services[name].volumes = [{ type: 'volume', source: name, target: '/var/lib/celld' }];
  }
  result.services.controller.volumes = [{ type: 'volume', source: 'controller', target: '/var/lib/fogd' }];
  result.services.minio.volumes = [{ type: 'volume', source: 'bucket', target: '/data' }];
  return result;
}
test('restore changes resource names and pins images without changing private configuration', () => {
  const source = config();
  const images = Object.fromEntries(services.map(name => [name, 'sha256:' + 'a'.repeat(64)]));
  const target = restoredConfig(source, 'recovered', images);
  assert.equal(target.services.controller.environment.TOKEN, 'literal$VALUE${HOME}');
  assert.equal(target.volumes.bucket.name, 'recovered_bucket');
  assert.equal(target.networks.control.name, 'recovered_control');
  assert.equal(target.services.controller.image, images.controller);
  assert.equal(target.services.controller.build, undefined);
  assert.equal(source.volumes.bucket.name, 'original_bucket');
  assert.equal(composeLiteral(target).services.controller.environment.TOKEN, 'literal$$VALUE$${HOME}');
  assert.deepEqual(composeResolved(composeLiteral(target)), target);
});
test('backup topology rejects external writers and unsafe project names', () => {
  validateTopology(config());
  const external = config(); external.services.controller.environment.S3_ENDPOINT = 'https://external.test';
  assert.throws(() => validateTopology(external), /External bucket/);
  const bind = config(); bind.services.controller.volumes = [{ type: 'bind', source: '/host', target: '/data' }];
  assert.throws(() => validateTopology(bind), /named volumes/);
  for (const value of ['../other', '--host', 'UPPER', '', 'a'.repeat(64)]) assert.throws(() => projectName(value));
});
test('corrupt or incomplete bundles are rejected before Docker restoration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-recovery-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(verifyBundle(dir), /ENOENT/);
  const files = {};
  for (const file of ['compose.json', 'images.tar', ...volumes.map(v => `${v}.tar`)]) {
    await writeFile(join(dir, file), file === 'compose.json' ? JSON.stringify(config()) : 'archive');
    files[file] = await fingerprint(join(dir, file));
  }
  const manifest = { format: 'fogd-stopped-v1', files, images: Object.fromEntries(services.map(name => [name, 'sha256:' + 'b'.repeat(64)])) };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  assert.equal((await verifyBundle(dir)).manifest.format, manifest.format);
  await writeFile(join(dir, 'bucket.tar'), 'corrupt');
  await assert.rejects(verifyBundle(dir), /checksum mismatch/);
  await writeFile(join(dir, 'bucket.tar'), 'archive');
  await writeFile(join(dir, 'slot-2-a.tar'), 'corrupt skipped replica');
  const { retire } = await import('../src/recovery/retire.mjs');
  await assert.rejects(retire(dir, 'notebook', 'a'.repeat(64), 'fresh', join(dir, 'unused')), /checksum mismatch: slot-2-a/);
  delete manifest.files['slot-2-b.tar'];
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyBundle(dir), /Incomplete/);
});

test('running configuration drift is refused without disclosing values', async () => {
  const { checkContainer } = await import('../src/recovery/inventory.mjs');
  const image = { Config: { Cmd: ['node', 'main'], Entrypoint: null } };
  const container = { Config: { ...image.Config, Env: ['SECRET=actual-private', 'CELLD_NODE=node-a'] } };
  checkContainer({ environment: { SECRET: 'actual-private', CELLD_NODE: 'node-a' } }, container, image);
  assert.throws(() => checkContainer({ environment: { SECRET: 'different-private' } }, container, image), error => /differs/.test(error.message) && !error.message.includes('private'));
  assert.throws(() => checkContainer({ command: ['other'] }, container, image), /command differs/);
});


test('malformed backup JSON does not echo private configuration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-private-backup-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'compose.json');
  await writeFile(file, '{"SECRET":"private-config-value"');
  await assert.rejects(readJson(file), error => /Unreadable backup JSON/.test(error.message) && !error.message.includes('private-config-value'));
});

test('TLS archives are optional but must match the declared managed volumes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-tls-backup-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const source = config(); source.volumes.tls = { name: 'original_tls' };
  source.services.controller.volumes.push({ type: 'volume', source: 'tls', target: '/var/lib/fogd-tls', read_only: true });
  source.services.workerd.volumes = [{ type: 'volume', source: 'tls', target: '/var/lib/fogd-tls', read_only: true }];
  const files = {};
  for (const file of ['compose.json', 'images.tar', ...[...volumes, 'tls'].map(v => `${v}.tar`)]) {
    await writeFile(join(dir, file), file === 'compose.json' ? JSON.stringify(source) : 'archive');
    files[file] = await fingerprint(join(dir, file));
  }
  const manifest = { format: 'fogd-stopped-v1', files, images: Object.fromEntries(services.map(name => [name, 'sha256:' + 'b'.repeat(64)])) };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  assert.equal((await verifyBundle(dir)).config.volumes.tls.name, 'original_tls');
  delete manifest.files['tls.tar'];
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(verifyBundle(dir), /volume inventory/);
});

test('derived recovery layout rejects crossed fleet storage, writers, and unqualified counts', async () => {
  const { recoveryLayout } = await import('../src/recovery/layout.mjs');
  assert.deepEqual(recoveryLayout(config()).services, services);
  assert.deepEqual(recoveryLayout(config()).volumes, volumes);
  const cases = [
    [c => { c.services['slot-2-a'].environment.CELLD_BUCKET = 's3://fogd/slots/slot-1'; }, /Replica storage/],
    [c => { c.services['slot-2-a'].environment.CELLD_NODE = 'slot-1-a'; }, /Replica identities/],
    [c => { c.services['slot-2-a'].volumes[0].source = 'slot-1-a'; }, /volume mapping/],
    [c => { c.services['slot-2-a'].networks = { 'fleet-1': {} }; }, /network membership/],
    [c => { c.services['bucket-init'].environment.S3_ENDPOINT = 'http://outside:9000'; }, /Bucket initializer/],
    [c => { c.services.extra = {}; }, /two-slot/],
    [c => { c.volumes.extra = {}; }, /two-slot/],
    [c => { c.networks.extra = {}; }, /Unexpected recovery networks/],
  ];
  for (const [mutate, message] of cases) { const value = config(); mutate(value); assert.throws(() => validateTopology(value), { name: 'Error', message }); }
  for (const changed of [slots.slice(0, 1), [...slots, { id: 'slot-3', prefix: 'slots/slot-3', nodes: ['slot-3-a', 'slot-3-b'] }], [{ ...slots[0], nodes: slots[1].nodes }, slots[1]], [slots[0], { ...slots[1], prefix: slots[0].prefix + '/nested' }]]) {
    const value = config();
    for (const name of ['controller', 'workerd']) value.services[name].environment.FOGD_SLOTS = JSON.stringify(changed);
    assert.throws(() => validateTopology(value), error => error.constructor === Error && /two local fleets|ordered local fleet addresses|prefixes overlap/.test(error.message));
  }
});

test('bundle checks configuration integrity before parsing its fleet inventory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-layout-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'compose.json'), JSON.stringify(config()));
  const original = await fingerprint(join(dir, 'compose.json'));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({ format: 'fogd-stopped-v1', files: { 'compose.json': original } }));
  await writeFile(join(dir, 'compose.json'), '{"PRIVATE":"do-not-echo"');
  await assert.rejects(verifyBundle(dir), error => error.message === 'Backup checksum mismatch: compose.json');
});


test('retirement output remains a valid recoverable layout', async () => {
  const { planRetirement } = await import('../src/recovery/retirement-plan.mjs');
  const digest = 'a'.repeat(64);
  const state = { apps: { notebook: { slot: 'slot-2', active: 'release', route: 'active' } }, deployments: { release: { app: 'notebook', status: 'active', digest } } };
  const plan = planRetirement(config(), state, 'notebook', digest);
  validateTopology(plan.config);
  assert.deepEqual(plan.skipped, ['slot-2-a', 'slot-2-b']);
});
