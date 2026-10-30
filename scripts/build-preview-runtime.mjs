import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, chmod, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runtimeFamily } from '../packages/cli/src/runtime/catalog.mjs';
import { programInventory } from '../packages/cli/src/runtime/program-inventory.mjs';
import { docker } from '../packages/cli/src/recovery/docker.mjs';

const sources = ['backend', 'supervisor', 'deadline'].map(name => `packages/cli/src/preview/${name}.mjs`);
const template = 'docker/runtime-preview.Dockerfile';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Local COPY-only image assembly. A successful build is not catalog admission,
// runtime qualification, execution permission or a fresh target allocation.
export async function buildPreviewRuntime(destination) {
  const base = runtimeFamily('celld-archive-v9-linux-arm64'), output = resolve(destination);
  assert.deepEqual(await programInventory(process.cwd()), base.sourceFiles, 'Preview base requires the unchanged qualified native program tree');
  const images = JSON.parse(await docker(['image', 'inspect', base.image, base.storageImage]));
  assert.deepEqual(images.map(({ Id, Os, Architecture }) => ({ Id, Os, Architecture })), [base.image, base.storageImage].map(Id => ({ Id, Os: 'linux', Architecture: 'arm64' })));
  const captured = new Map();
  for (const path of [...sources, template]) captured.set(path, await readFile(path));
  await mkdir(output, { mode: 0o700 });
  const context = join(output, 'context'); await mkdir(context, { mode: 0o755 });
  await mkdir(join(context, 'app'), { mode: 0o755 });
  await mkdir(join(context, 'app/preview'), { mode: 0o755 });
  for (const [path, bytes] of captured) {
    const target = join(context, path === template ? 'Dockerfile' : `app/preview/${path.split('/').at(-1)}`);
    await writeFile(target, bytes, { flag: 'wx', mode: 0o644 }); await utimes(target, 0, 0);
  }
  for (const path of [context, join(context, 'app'), join(context, 'app/preview')]) { await chmod(path, 0o755); await utimes(path, 0, 0); }
  const tags = [`fogd-runtime:preview-base-${base.image.slice(7, 19)}`, `fogd-storage:preview-base-${base.storageImage.slice(7, 19)}`];
  for (const [index, tag] of tags.entries()) {
    await docker(['tag', [base.image, base.storageImage][index], tag]);
    assert.equal((await docker(['image', 'inspect', tag, '--format', '{{.Id}}'])).trim(), [base.image, base.storageImage][index]);
  }
  const builder = (await docker(['context', 'show'])).trim();
  assert.match(await docker(['buildx', 'inspect', builder]), /^Driver:\s+docker\s*$/m);
  const builds = [];
  for (const attempt of [1, 2]) {
    const image = (await docker(['build', '--builder', builder, '--quiet', '--no-cache', '--network', 'none', '--build-arg', 'SOURCE_DATE_EPOCH=0',
      '--build-arg', `RUNTIME_IMAGE=${tags[0]}`, '--build-arg', `STORAGE_IMAGE=${tags[1]}`, context])).trim();
    assert.match(image, /^sha256:[a-f0-9]{64}$/, `Invalid preview packaging result ${attempt}`); builds.push(image);
    await writeFile(join(output, 'builds.json'), JSON.stringify({ complete: false, builds }, null, 2) + '\n', { mode: 0o600 });
  }
  assert.equal(builds[0], builds[1], 'Preview image assembly did not reproduce');
  for (const [path, bytes] of captured) {
    assert.equal(sha256(await readFile(path)), sha256(bytes), 'Preview source changed during assembly');
    const target = join(context, path === template ? 'Dockerfile' : `app/preview/${path.split('/').at(-1)}`);
    assert.equal(sha256(await readFile(target)), sha256(bytes), 'Preview context changed during assembly');
  }
  assert.deepEqual(await programInventory(process.cwd()), base.sourceFiles);
  const receipt = { schema: 1, image: builds[0], builds, baseFamily: base.id, baseImage: base.image, storageSourceImage: base.storageImage,
    baseCatalogEntrySha256: sha256(JSON.stringify(base, null, 2) + '\n'), binarySha256: base.binarySha256,
    sourceFiles: Object.fromEntries([...captured].map(([path, bytes]) => [path, sha256(bytes)])),
    scope: 'Local reproducible preview backend image; no installation, launch authority or qualified catalog admission.', qualified: false, admission: 'none' };
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/build-preview-runtime.mjs FRESH_PRIVATE_OUTPUT_DIRECTORY');
  console.log(JSON.stringify(await buildPreviewRuntime(process.argv[2]), null, 2));
}
