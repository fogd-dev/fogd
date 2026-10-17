import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, verifyBundle, readJson, restoredConfig, composeLiteral, composeResolved, validateTopology } from '../src/recovery/bundle.mjs';
import { services, volumes, projectName } from '../src/recovery/docker.mjs';

function config() {
  return { name: 'original', services: Object.fromEntries(services.map(name => [name, { image: 'mutable:tag', build: '.', environment: { S3_ENDPOINT: 'http://minio:9000', TOKEN: 'literal$VALUE${HOME}' } }])), volumes: Object.fromEntries(volumes.map(name => [name, { name: `original_${name}` }])), networks: { control: { name: 'original_control' } } };
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
  source.services.controller.volumes = [{ type: 'volume', source: 'tls', target: '/var/lib/fogd-tls', read_only: true }];
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
