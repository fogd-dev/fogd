import assert from 'node:assert/strict';
import { cp, mkdir, readFile, readdir, chmod, utimes } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { writeJson } from '../packages/cli/src/recovery/bundle.mjs';
import { programInventory } from '../packages/cli/src/runtime/program-inventory.mjs';
import { verifyRuntimeFamily, validateRuntimeFamily } from '../packages/cli/src/runtime/catalog.mjs';
import { runtimeInspector } from '../packages/cli/src/runtime/cron-image.mjs';

// This packages already checked native/dependency bytes. No pull, package
// installation, native compilation, per-installation data or probe is included.
const recipe = {
  schema: 1, id: 'celld-cron-v2-linux-arm64', admission: 'candidate', os: 'linux', architecture: 'arm64',
  parentImage: 'sha256:1a12f8e86a6725f26b3f5bf92a1232c626df91c20019185b83d5c0e4dbeab5dc',
  storageImage: 'sha256:6461aac3f6bcaa8e62d63ed712828a2a3dc5f766daf9cf66e52ef65d1187a79a',
  binarySha256: '25a7978046d9621ea394fdaf1f38c3de95381c81ac431fef940aad6995ab2fad',
  supervisorSha256: '2d60e95f752daedd969e94316de7267fc0e30d49f42a2657eb3f98ccd4b14452',
};
const dependencySeed = 'sha256:1ee29c8d41f6b4e46db616413c2f6676fbe1639283658196e11891af8237bdae';
const sourcePaths = ['packages/platform/src', 'packages/runtime/src', 'packages/platform/package.json', 'packages/runtime/package.json'];
const docker = (args, options) => execute('docker', args, options);
if (process.argv.length !== 3) throw new Error('Usage: node scripts/build-selected-runtime.mjs PRIVATE_OUTPUT_DIRECTORY');
const output = resolve(process.argv[2]); await mkdir(output, { mode: 0o700 });
await verifyDependencies();
const sourceFiles = await programInventory(process.cwd());
validateRuntimeFamily({ ...recipe, image: recipe.parentImage, sourceFiles });
await verifySourcePaths(sourceFiles);
const context = join(output, 'context'); await mkdir(context);
for (const name of ['platform', 'runtime']) {
  const target = join(context, 'packages', name); await mkdir(target, { recursive: true });
  await cp(`packages/${name}/src`, join(target, 'src'), { recursive: true });
  await cp(`packages/${name}/package.json`, join(target, 'package.json'));
}
await cp('docker/runtime-selected.Dockerfile', join(context, 'Dockerfile'));
assert.deepEqual(await programInventory(context), sourceFiles);
await normalize(context);
const base = 'fogd-runtime:cron-v2-dependency-base'; await docker(['tag', recipe.parentImage, base]);
assert.equal((await docker(['image', 'inspect', '--format', '{{.Id}}', base])).trim(), recipe.parentImage);
const builder = (await docker(['context', 'show'])).trim();
const driver = await docker(['buildx', 'inspect', builder]);
assert.match(driver, /^Driver:\s+docker\s*$/m, 'Packaging needs the current context Docker driver and its cached parent');
// The pinned dependency input is already clean. COPY-only assembly avoids
// volatile cleanup whiteouts; prove reproducibility with two uncached builds.
const builds = [];
for (const attempt of [1, 2]) {
  const built = (await docker(['build', '--builder', builder, '--quiet', '--no-cache', '--network', 'none', '--build-arg', 'SOURCE_DATE_EPOCH=0', context])).trim();
  assert.match(built, /^sha256:[a-f0-9]{64}$/, `Invalid packaging result ${attempt}`); builds.push(built);
}
assert.equal(builds[0], builds[1], 'Identical source did not reproduce the product runtime image');
const image = builds[0];
const entry = { ...recipe, image, sourceFiles };
await verifyRuntimeFamily(entry);
assert.deepEqual(await programInventory(process.cwd()), sourceFiles, 'Source changed during runtime packaging');
const [built, parent, seed] = JSON.parse(await docker(['image', 'inspect', image, recipe.parentImage, dependencySeed]));
assert.deepEqual(parent.RootFS.Layers.slice(0, seed.RootFS.Layers.length), seed.RootFS.Layers);
assert.equal(parent.RootFS.Layers.length, seed.RootFS.Layers.length + 1);
assert.equal(built.RootFS.Layers.length, parent.RootFS.Layers.length + 1, 'Product assembly must add exactly its source COPY layer');
assert.deepEqual(built.RootFS.Layers.slice(0, parent.RootFS.Layers.length), parent.RootFS.Layers);
assert.equal(built.Created, '1970-01-01T00:00:00Z');
await writeJson(join(output, 'candidate.json'), entry);
await writeJson(join(output, 'result.json'), { image, parent: parent.Id, dependencySeed: seed.Id, seedLayersPreserved: true, cleanInputReproducedFromSeed: false, createdAt: built.Created, sourceFileCount: Object.keys(sourceFiles).length,
  repeatedUncachedBuilds: builds, identicalImageIds: true, ...await sourceProvenance(sourceFiles),
  dockerServer: JSON.parse(await docker(['version', '--format', '{{json .Server}}'])), buildDriver: driver,
  runtimePrebootPassed: true, completeSourceInventoryPassed: true, applicationContainersStarted: false, nativeRebuild: false, dependencyInstall: false });
console.log(`Packaged candidate ${entry.id}: ${image}. Qualification and ordinary enrollment remain closed.`);

async function normalize(path) {
  for (const item of await readdir(path, { withFileTypes: true })) {
    const file = join(path, item.name);
    if (item.isDirectory()) await normalize(file);
    else { assert.ok(item.isFile()); await chmod(file, 0o644); await utimes(file, 0, 0); }
  }
  await chmod(path, 0o755); await utimes(path, 0, 0);
}
async function verifySourcePaths(files) {
  const listed = (await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...sourcePaths])).split('\0').filter(Boolean);
  const deleted = new Set((await execute('git', ['ls-files', '--deleted', '-z', '--', ...sourcePaths])).split('\0'));
  assert.deepEqual(Object.keys(files).sort(), [...new Set(listed.filter(path => !deleted.has(path)))].sort(), 'Ignored or unknown runtime program files must not enter the image');
}
async function verifyDependencies() {
  await docker(['image', 'inspect', recipe.parentImage, recipe.storageImage]);
  const names = ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'packages/runtime/package.json'];
  const code = `import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';const files={};for(const name of ${JSON.stringify(names)})files[name]=createHash('sha256').update(await readFile(name)).digest('hex');console.log(JSON.stringify({files,root:JSON.parse(await readFile('package.json')),platform:JSON.parse(await readFile('packages/platform/package.json'))}));`;
  const installed = JSON.parse(await runtimeInspector(recipe.parentImage, code));
  for (const name of names) assert.equal(createHash('sha256').update(await readFile(name)).digest('hex'), installed.files[name], 'Dependency manifests changed; requalify the dependency base');
  for (const [key, path, ignored] of [['root', 'package.json', 'scripts'], ['platform', 'packages/platform/package.json', 'exports']]) {
    const local = JSON.parse(await readFile(path)); delete local[ignored]; delete installed[key][ignored];
    assert.deepEqual(local, installed[key], 'Dependency declarations changed; requalify the dependency base');
  }
}

async function sourceProvenance(files) {
  const sourceTreeDirty = Boolean((await execute('git', ['status', '--porcelain', '--untracked-files=all', '--', ...sourcePaths, 'scripts/build-selected-runtime.mjs', 'docker/runtime-selected.Dockerfile'])).trim());
  const sourceInventorySha256 = createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  const packagingFiles = {};
  for (const name of ['scripts/build-selected-runtime.mjs', 'docker/runtime-selected.Dockerfile']) packagingFiles[name] = createHash('sha256').update(await readFile(name)).digest('hex');
  return { sourceTreeDirty, sourceInventorySha256, packagingFiles, sourceCommit: sourceTreeDirty ? null : (await execute('git', ['rev-parse', 'HEAD'])).trim() };
}
