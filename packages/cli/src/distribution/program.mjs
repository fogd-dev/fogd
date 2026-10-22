import { createRequire } from 'node:module';
import { realpath, link, unlink } from 'node:fs/promises';
import { readTransferMetadata } from './bootstrap.mjs';
import { join, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { transferFiles, transferFingerprint, copyTransferFile, ordinaryDirectory } from './files.mjs';
import { publicProgramPath, operatorFiles, ignoreFiles } from './manifest.mjs';

export async function programInputs(root) {
  const files = new Map(operatorFiles.map(path => [path, join(root, path)]));
  for (const name of ['cli', 'runtime', 'platform']) {
    const base = `packages/${name}`;
    await ordinaryDirectory(join(root, base));
    files.set(`${base}/package.json`, join(root, base, 'package.json'));
    for (const path of await transferFiles(join(root, base, 'src'))) files.set(`${base}/src/${path}`, join(root, base, 'src', path));
    if (name !== 'cli') for (const [path, source] of [...files]) if (path.startsWith(`${base}/`)) files.set(path.replace('packages/', 'node_modules/@fogd/'), source);
  }
  files.set('packages/cli/bin/fogd.js', join(root, 'packages/cli/bin/fogd.js'));
  const runtime = await readTransferMetadata(join(root, 'packages/runtime/package.json'));
  const library = await realpath(dirname(createRequire(join(root, 'packages/runtime/package.json')).resolve('ignore/package.json')));
  const metadata = await readTransferMetadata(join(library, 'package.json'));
  if (metadata.name !== 'ignore' || metadata.version !== runtime.dependencies.ignore || metadata.license !== 'MIT') throw new Error('Cached operator dependency differs from the declared package');
  for (const name of ignoreFiles) files.set(`node_modules/ignore/${name}`, join(library, name));
  if ([...files.keys()].some(path => !publicProgramPath(path))) throw new Error('Unexpected file in public operator source inputs');
  return files;
}
export async function programInventory(inputs) {
  const files = {};
  for (const [path, source] of inputs) files[`program/${path}`] = await transferFingerprint(source, 4 * 1024 ** 2);
  return files;
}
export async function copyProgram(inputs, destination, expected) {
  // Publish the normal CLI entrypoint after all program files have verified.
  const ordered = [...inputs].sort(([a], [b]) => Number(a === 'packages/cli/bin/fogd.js') - Number(b === 'packages/cli/bin/fogd.js'));
  for (const [path, source] of ordered) {
    const target = join(destination, path), pending = `${target}.pending`;
    await copyTransferFile(source, pending);
    if (!isDeepStrictEqual(await transferFingerprint(pending), expected[`program/${path}`])) throw new Error('Installed operator file differs from the authenticated transfer');
    await link(pending, target); await unlink(pending);
  }
}
export async function assertProgramUnchanged(inputs, expected) {
  if (!isDeepStrictEqual(await programInventory(inputs), expected)) throw new Error('Operator source changed during transfer export');
}
