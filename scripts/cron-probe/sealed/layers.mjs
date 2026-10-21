import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';

export async function addedLayers(directory, image, parent) {
  const archive = join(directory, 'image.tar');
  await execute('docker', ['image', 'save', image.Id], { output: archive });
  const read = path => execute('tar', ['-xOf', archive, path]);
  const [manifest] = JSON.parse(await read('manifest.json'));
  assert.ok([`${image.Id.slice(7)}.json`, `blobs/sha256/${image.Id.slice(7)}`].includes(manifest.Config));
  const config = await read(manifest.Config);
  assert.equal(`sha256:${createHash('sha256').update(config).digest('hex')}`, image.Id);
  assert.deepEqual(JSON.parse(config).rootfs.diff_ids, image.RootFS.Layers);
  assert.equal(manifest.Layers.length, image.RootFS.Layers.length);
  assert.equal(image.RootFS.Layers.length - parent.RootFS.Layers.length, 2, 'The private image may add only its two reviewed COPY layers');
  const result = [];
  for (let index = parent.RootFS.Layers.length; index < manifest.Layers.length; index++) {
    const file = join(directory, `added-${index}.tar`);
    await execute('tar', ['-xOf', archive, manifest.Layers[index]], { output: file });
    const digest = await layerDigest(file); assert.equal(`sha256:${digest}`, image.RootFS.Layers[index]);
    const paths = (await execute('tar', ['-tf', file])).trim().split('\n').filter(Boolean);
    const verbose = (await execute('tar', ['-tvf', file])).trim().split('\n').filter(Boolean);
    assert.ok(verbose.every(line => ['d', '-'].includes(line[0])), 'No added layer may contain links or special files');
    assert.ok(paths.every(allowedPath), 'Added image layers may contain only reviewed package sources/manifests and qualification programs');
    result.push({ diffId: image.RootFS.Layers[index], paths });
  }
  return result;
}
function allowedPath(raw) {
  const path = raw.replace(/^\.\//, '').replace(/\/$/, '');
  if (path.startsWith('/') || path.split('/').some(part => part === '..' || part.startsWith('.wh.'))) return false;
  const directories = ['app', 'app/packages', 'app/packages/platform', 'app/packages/runtime', 'app/qualification'];
  return directories.includes(path) || /^app\/packages\/(platform|runtime)\/(src(?:\/.*)?|package\.json)$/.test(path) || /^app\/qualification\/(backend\.mjs|controller\.mjs|controller-artifact\.mjs|runtime-policy\.json)$/.test(path);
}
async function layerDigest(path) {
  const file = await open(path, 'r'), header = Buffer.alloc(2);
  try { await file.read(header, 0, 2, 0); } finally { await file.close(); }
  const input = createReadStream(path), stream = header[0] === 0x1f && header[1] === 0x8b ? input.pipe(createGunzip()) : input;
  const hash = createHash('sha256'); for await (const chunk of stream) hash.update(chunk); return hash.digest('hex');
}
