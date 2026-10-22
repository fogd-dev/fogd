import { mkdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFamily, verifyRuntimeFamily } from '../runtime/catalog.mjs';
import { docker } from '../recovery/docker.mjs';
import { writeJson } from '../recovery/bundle.mjs';
import { transferFingerprint, copyTransferFile, ordinaryDirectory } from './files.mjs';
import { transferFormat, validateTransferManifest, assertRuntimeSources } from './manifest.mjs';
import { programInputs, programInventory, copyProgram, assertProgramUnchanged } from './program.mjs';
import { verifyTransferBundle } from './verify.mjs';
import { withTransferSnapshot } from './snapshot.mjs';
import { verifyTransferHost } from './host.mjs';
import { verifyTransferArchive } from './archive.mjs';

const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
export async function exportRuntimeBundle(directory, family) {
  const entry = runtimeFamily(family), output = await canonicalDestination(directory);
  for (const path of ['packages', 'node_modules', 'docs']) if (inside(join(sourceRoot, path), output)) throw new Error('Transfer output must be outside public source directories');
  await newDestination(output);
  const inputs = await programInputs(sourceRoot), files = await programInventory(inputs);
  assertQualifiedSources(files, entry);
  const sourceEngine = await verifyTransferHost();
  await verifyRuntimeFamily(entry);
  await mkdir(output, { mode: 0o700 });
  await copyProgram(inputs, join(output, 'program'), files);
  await docker(['image', 'save', entry.image, entry.storageImage], { output: join(output, 'images.tar') });
  await assertProgramUnchanged(inputs, files);
  await copyTransferFile(join(sourceRoot, 'packages/cli/src/distribution/bootstrap.mjs'), join(output, 'verify-transfer.mjs'));
  files['verify-transfer.mjs'] = await transferFingerprint(join(output, 'verify-transfer.mjs'));
  files['images.tar'] = await transferFingerprint(join(output, 'images.tar'));
  const manifest = validateTransferManifest({ format: transferFormat, runtime: entry, files }, entry);
  await verifyTransferArchive(join(output, 'images.tar'), entry);
  await writeJson(join(output, 'manifest.json'), manifest);
  return { directory: output, family: entry.id, sourceEngine, bootstrapSha256: files['verify-transfer.mjs'].sha256, manifestSha256: (await transferFingerprint(join(output, 'manifest.json'))).sha256 };
}
export async function importRuntimeBundle(directory, family, expected, destination) {
  const entry = runtimeFamily(family), source = resolve(directory), output = await canonicalDestination(destination);
  await ordinaryDirectory(source);
  if (inside(await realpath(source), output)) throw new Error('Installation output must be outside the transfer bundle');
  await newDestination(output);
  const manifest = await verifyTransferBundle(source, entry, expected);
  const targetEngine = await verifyTransferHost();
  return withTransferSnapshot(source, entry, expected, manifest, dirname(output), async verified => {
    await verifyTransferArchive(join(verified, 'images.tar'), entry);
    await docker(['image', 'load'], { input: join(verified, 'images.tar') });
    await verifyRuntimeFamily(entry);
    await mkdir(output, { mode: 0o700 });
    const inputs = new Map(Object.keys(manifest.files).filter(path => path.startsWith('program/')).map(path => [path.slice(8), join(verified, path)]));
    await writeJson(join(output, 'transfer-receipt.json'), { format: transferFormat, family, manifestSha256: expected, images: [entry.image, entry.storageImage], targetEngine });
    await copyProgram(inputs, output, manifest.files);
    return { directory: output, family, manifestSha256: expected, servicesStarted: false };
  });
}
async function canonicalDestination(path) {
  const absolute = resolve(path);
  return join(await realpath(dirname(absolute)), basename(absolute));
}
async function newDestination(path) {
  try { await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Transfer destination already exists; retain it and choose a fresh directory');
}
function inside(root, path) {
  const result = relative(root, path);
  return !result || (!result.startsWith('..' + '/') && result !== '..' && !isAbsolute(result));
}
function assertQualifiedSources(files, entry) {
  try { assertRuntimeSources(files, entry.sourceFiles); }
  catch { throw new Error('Checkout runtime sources have drifted from the frozen family; use its matching checkout or qualify a new family'); }
}
