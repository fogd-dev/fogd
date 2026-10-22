import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyTransferArchive } from '../src/distribution/archive.mjs';
const exec = promisify(execFile), sha = text => createHash('sha256').update(text).digest('hex');
async function fixture(t, change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-archive-')); t.after(() => rm(root, { recursive: true, force: true }));
  const config = ['runtime', 'storage'].map(role => JSON.stringify({ architecture: 'arm64', os: 'linux', config: { Labels: { role } } }));
  const hashes = config.map(sha), entry = { image: `sha256:${hashes[0]}`, storageImage: `sha256:${hashes[1]}`, os: 'linux', architecture: 'arm64' };
  const files = { 'manifest.json': JSON.stringify(hashes.map(hash => ({ Config: `${hash}.json`, RepoTags: null, Layers: ['layer.tar'] }))),
    [`${hashes[0]}.json`]: config[0], [`${hashes[1]}.json`]: config[1], 'layer.tar': 'fixture layer' };
  change(files, entry, hashes);
  const source = join(root, 'source'); await mkdir(source);
  for (const [name, data] of Object.entries(files)) { await mkdir(join(source, name, '..'), { recursive: true }); await writeFile(join(source, name), data); }
  const archive = join(root, 'images.tar'); await exec('tar', ['-cf', archive, '-C', source, ...Object.keys(files)]);
  return { archive, entry };
}
function records(files, change) { const value = JSON.parse(files['manifest.json']); change(value); files['manifest.json'] = JSON.stringify(value); }
for (const [name, change, message] of [
  ['mutable image tag', files => records(files, v => { v[0].RepoTags = ['operator:existing']; }), /tags or unsupported/],
  ['unexpected image count', files => records(files, v => { v.pop(); }), /exactly/],
  ['duplicate image identity', files => records(files, v => { v[1] = v[0]; }), /inventory differs/],
  ['option-shaped config path', files => records(files, v => { v[0].Config = '-I'; }), /tags or unsupported/],
  ['traversal config path', files => records(files, v => { v[0].Config = '../private'; }), /tags or unsupported/],
  ['traversal layer path', files => records(files, v => { v[0].Layers = ['../private']; }), /tags or unsupported/],
  ['wrong config bytes', (files, entry, hashes) => { files[`${hashes[0]}.json`] = JSON.stringify({ architecture: 'amd64', os: 'linux' }); }, /identity or architecture/],
  ['wrong platform', (files, entry) => { entry.architecture = 'amd64'; }, /identity or architecture/],
  ['unreadable metadata', files => { files['manifest.json'] = 'private-not-json'; }, /Unreadable image archive metadata/],
  ['tagged OCI index', files => { files['index.json'] = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: `sha256:${'a'.repeat(64)}`, annotations: { 'io.containerd.image.name': 'operator:existing' } }] }); }, /unexpected digest or tag/],
]) test(`archive refuses ${name}`, async t => {
  const f = await fixture(t, change);
  await assert.rejects(verifyTransferArchive(f.archive, f.entry), message);
});

test('an untagged two-image archive passes the metadata preflight', async t => {
  const f = await fixture(t);
  assert.equal(await verifyTransferArchive(f.archive, f.entry), undefined);
});

test('OCI blob configuration and an untagged partial index match the classic Docker archive', async t => {
  const f = await fixture(t, (files, entry, hashes) => {
    const image = JSON.stringify({ schemaVersion: 2, config: { digest: entry.image } }), digest = sha(image);
    files['index.json'] = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: `sha256:${digest}` }] });
    files[`blobs/sha256/${digest}`] = image;
    records(files, value => { value[0].Config = `blobs/sha256/${hashes[0]}`; value[1].Config = `blobs/sha256/${hashes[1]}`; });
    files[`blobs/sha256/${hashes[0]}`] = files[`${hashes[0]}.json`]; delete files[`${hashes[0]}.json`];
    files[`blobs/sha256/${hashes[1]}`] = files[`${hashes[1]}.json`]; delete files[`${hashes[1]}.json`];
  });
  assert.equal(await verifyTransferArchive(f.archive, f.entry), undefined);
});
