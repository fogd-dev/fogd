import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { paddedUpload } from '../../../scripts/capacity/padded-upload.mjs';
import { artifactDigest } from '../../runtime/src/artifact.mjs';
import { MAX_UPLOAD } from '../../runtime/src/manifest.mjs';

test('maximum upload digest matches the runtime digest of the decoded file tree', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fogd-padded-upload-')); t.after(() => rm(root, { recursive: true, force: true }));
  const original = { app: 'peer', digest: 'a'.repeat(64), files: [{ path: 'worker/index.js', data: 'ZXhwb3J0IGRlZmF1bHQge307' }, { path: 'wrangler.json', data: 'e30=' }] };
  const result = paddedUpload(original), artifact = JSON.parse(result.payload);
  await Promise.all(artifact.files.map(async file => { const target = join(root, file.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, Buffer.from(file.data, 'base64')); }));
  assert.equal(result.artifactBytes, MAX_UPLOAD); assert.equal(artifact.files.reduce((sum, file) => sum + Buffer.from(file.data, 'base64').length, 0), MAX_UPLOAD);
  assert.equal(artifact.digest, await artifactDigest(root)); assert.equal(result.digest, artifact.digest);
  assert.deepEqual(artifact.files.filter(file => file.path.startsWith('assets/capacity-')).map(file => Buffer.from(file.data, 'base64').length), [16777216, 16777196]);
  assert.equal(original.files.length, 2); assert.equal(original.digest, 'a'.repeat(64));
});
