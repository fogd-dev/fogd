import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, chmod, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createReadStream } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { runtimeFamily } from '../packages/cli/src/runtime/catalog.mjs';
import { programInventory } from '../packages/cli/src/runtime/program-inventory.mjs';
import { docker } from '../packages/cli/src/recovery/docker.mjs';
import { writePreviewArchive } from './preview-runtime-archive.mjs';

const sources = ['backend', 'supervisor', 'deadline', 'control', 'control-input', 'control-main', 'execution', 'execution-authority', 'execution-shape', 'input-files']
  .map(name => `packages/cli/src/preview/${name}.mjs`).concat(['packages/cli/src/build-cache/paths.mjs', 'packages/cli/package.json']);
const template = 'docker/runtime-preview.Dockerfile';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function fileSha256(path) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex');
}

async function writeContext(output, captured, storageImage) {
  const context = join(output, 'context'); await mkdir(context, { mode: 0o755 });
  const inspector = (await docker(['create', '--name', `fogd-preview-storage-source-${randomUUID()}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '1', '--pids-limit', '64', '--entrypoint', '/usr/local/bin/minio', storageImage, '--version'])).trim();
  await writeFile(join(output, 'source-inspector.json'), JSON.stringify({ id: inspector, image: storageImage, started: false }) + '\n', { flag: 'wx', mode: 0o600 });
  const binary = join(output, 'minio'); await docker(['cp', `${inspector}:/usr/local/bin/minio`, binary]); await chmod(binary, 0o600);
  const members = new Map([...captured].filter(([path]) => path !== template).map(([path, bytes]) => [`app/${path}`, { bytes }]));
  members.set('usr/local/bin/minio', { source: binary, mode: 0o755 });
  for (const name of ['runtime', 'platform']) members.set(`app/packages/cli/node_modules/@fogd/${name}`, { link: `../../../${name}` });
  await writePreviewArchive(join(context, 'root.tar'), members);
  await writeFile(join(context, 'Dockerfile'), captured.get(template), { flag: 'wx', mode: 0o644 });
  for (const path of [context, join(context, 'root.tar'), join(context, 'Dockerfile')]) await utimes(path, 0, 0);
  return { context, sourceInspector: inspector, storageBinarySha256: await fileSha256(binary), archiveSha256: await fileSha256(join(context, 'root.tar')) };
}

// Local normalized archive assembly, with no dependency download or
// native compilation. A successful build is not catalog admission,
// runtime qualification, execution permission or a fresh target allocation.
export async function buildPreviewRuntime(destination) {
  const base = runtimeFamily('celld-archive-v9-linux-arm64'), output = resolve(destination);
  assert.deepEqual(await programInventory(process.cwd()), base.sourceFiles, 'Preview base requires the unchanged qualified native program tree');
  const images = JSON.parse(await docker(['image', 'inspect', base.image, base.storageImage]));
  assert.deepEqual(images.map(({ Id, Os, Architecture }) => ({ Id, Os, Architecture })), [base.image, base.storageImage].map(Id => ({ Id, Os: 'linux', Architecture: 'arm64' })));
  assert.equal(Object.keys(images[1].Config.Volumes || {}).length, 0, 'Storage source inspector must not allocate anonymous data');
  const captured = new Map();
  for (const path of [...sources, template]) captured.set(path, await readFile(path));
  await mkdir(output, { mode: 0o700 });
  const assembled = await writeContext(output, captured, base.storageImage), { context } = assembled;
  const tags = [`fogd-runtime:preview-base-${base.image.slice(7, 19)}`, `fogd-storage:preview-base-${base.storageImage.slice(7, 19)}`];
  for (const [index, tag] of tags.entries()) {
    await docker(['tag', [base.image, base.storageImage][index], tag]);
    assert.equal((await docker(['image', 'inspect', tag, '--format', '{{.Id}}'])).trim(), [base.image, base.storageImage][index]);
  }
  const builder = (await docker(['context', 'show'])).trim();
  assert.match(await docker(['buildx', 'inspect', builder]), /^Driver:\s+docker\s*$/m);
  const builds = [];
  for (const attempt of [1, 2]) {
    if (attempt === 2) await delay(2000);
    const image = (await docker(['build', '--builder', builder, '--quiet', '--no-cache', '--network', 'none', '--build-arg', 'SOURCE_DATE_EPOCH=0',
      '--build-arg', `RUNTIME_IMAGE=${tags[0]}`, '--build-arg', `STORAGE_IMAGE=${tags[1]}`, context])).trim();
    assert.match(image, /^sha256:[a-f0-9]{64}$/, `Invalid preview packaging result ${attempt}`); builds.push(image);
    await writeFile(join(output, 'builds.json'), JSON.stringify({ complete: false, builds }, null, 2) + '\n', { mode: 0o600 });
  }
  assert.equal(builds[0], builds[1], 'Preview image assembly did not reproduce');
  for (const [path, bytes] of captured) {
    assert.equal(sha256(await readFile(path)), sha256(bytes), 'Preview source changed during assembly');
  }
  assert.equal(await fileSha256(join(context, 'root.tar')), assembled.archiveSha256);
  assert.equal(sha256(await readFile(join(context, 'Dockerfile'))), sha256(captured.get(template)));
  assert.deepEqual(await programInventory(process.cwd()), base.sourceFiles);
  const receipt = { schema: 1, image: builds[0], builds, baseFamily: base.id, baseImage: base.image, storageSourceImage: base.storageImage,
    baseCatalogEntrySha256: sha256(JSON.stringify(base, null, 2) + '\n'), binarySha256: base.binarySha256,
    sourceFiles: Object.fromEntries([...captured].map(([path, bytes]) => [path, sha256(bytes)])),
    sourceInspector: assembled.sourceInspector, storageBinarySha256: assembled.storageBinarySha256, archiveSha256: assembled.archiveSha256,
    scope: 'Local reproducible preview controller/backend image; no installation or qualified catalog admission.', qualified: false, admission: 'none' };
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/build-preview-runtime.mjs FRESH_PRIVATE_OUTPUT_DIRECTORY');
  console.log(JSON.stringify(await buildPreviewRuntime(process.argv[2]), null, 2));
}
