import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeJson } from '../packages/cli/src/recovery/bundle.mjs';

// Source-only preparation: no compilation, network, upstream script or worktree
// bytes. Objects are read raw and re-hashed from the pinned commit down, so
// local attributes, filters, replace refs and hooks never shape the output.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
const gitSafety = ['--no-lazy-fetch', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function git(cwd, args, options = {}) {
  return execFileSync('git', [...gitSafety, ...args], { cwd, env: gitEnv, maxBuffer: 1024 ** 3, stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

export async function prepareRuntimeSource({ repository, output, manifest, patchRoot = root }) {
  validateManifest(manifest);
  const gitDir = git(repository, ['rev-parse', '--path-format=absolute', '--git-common-dir']).toString().trim();
  const target = await placeOutput(output, [repository, gitDir, patchRoot]);
  const files = readPinnedTree(repository, manifest.revision);
  const lock = files.get('Cargo.lock');
  if (!lock || sha256(lock.bytes) !== manifest.cargoLockSha256) throw new Error('Pinned Cargo.lock does not match the declared hash');
  const patches = await readPatches(manifest, patchRoot);
  await mkdir(target, { mode: 0o700 });
  try { return await assemble(target, files, patches, manifest); }
  catch (error) { await writeJson(join(target, 'failure.json'), { complete: false, error: error.message }); throw error; }
}

function validateManifest(manifest) {
  if (manifest.schema !== 1 || !/^[0-9a-f]{40}$/.test(manifest.revision)) throw new Error('Runtime source manifest needs schema 1 and a full revision');
  const hashes = [manifest.cargoLockSha256, manifest.sourceInventorySha256, ...manifest.patches.map(patch => patch.sha256)];
  if (!hashes.every(hash => /^[0-9a-f]{64}$/.test(hash))) throw new Error('Runtime source manifest has an invalid SHA256');
}

// Resolves the parent through symlinks, so an aliased path cannot land inside an input.
export async function placeOutput(output, inputs) {
  const target = join(await realpath(dirname(resolve(output))), basename(resolve(output)));
  for (const input of inputs) {
    const path = relative(await realpath(input), target);
    if (!path || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))) throw new Error(`Output must be outside input ${input}`);
  }
  return target;
}

// Every object is hashed against its parent's reference, starting at the pinned revision.
function readPinnedTree(repository, revision) {
  const [commit] = readObjects(repository, [revision], 'commit');
  const files = new Map();
  let trees = [[/^tree ([0-9a-f]{40})$/m.exec(commit.toString('latin1'))[1], '']];
  while (trees.length) {
    const entries = readObjects(repository, trees.map(([id]) => id), 'tree').flatMap((raw, index) => treeEntries(raw, trees[index][1]));
    trees = entries.filter(entry => entry.mode === '40000').map(entry => [entry.id, `${entry.path}/`]);
    const blobs = entries.filter(entry => entry.mode !== '40000');
    readObjects(repository, blobs.map(blob => blob.id), 'blob').forEach((bytes, index) => files.set(blobs[index].path, { mode: blobs[index].mode, bytes }));
  }
  return files;
}

function readObjects(repository, ids, type) {
  if (!ids.length) return [];
  const out = git(repository, ['cat-file', '--batch'], { input: ids.join('\n') + '\n' });
  const objects = []; let offset = 0;
  for (const id of ids) {
    const end = out.indexOf(10, offset);
    const [name, actual, size] = out.subarray(offset, end).toString().split(' ');
    if (name !== id || actual !== type) throw new Error(`Pinned ${type} ${id} is missing or has the wrong type`);
    const bytes = out.subarray(end + 1, end + 1 + Number(size));
    if (createHash('sha1').update(`${type} ${size}\0`).update(bytes).digest('hex') !== id) throw new Error(`Pinned object ${id} fails its hash`);
    objects.push(bytes); offset = end + 2 + Number(size);
  }
  return objects;
}

function treeEntries(raw, prefix) {
  const entries = [];
  for (let offset = 0; offset < raw.length;) {
    const nul = raw.indexOf(0, offset);
    const [mode, name] = splitOnce(raw.subarray(offset, nul).toString());
    if (!['40000', '100644', '100755'].includes(mode)) throw new Error(`Pinned source has unsupported entry ${prefix}${name} (${mode})`);
    if (['', '.', '..'].includes(name) || name.includes('/') || name.toLowerCase() === '.git') throw new Error(`Pinned source has unsafe path ${prefix}${name}`);
    entries.push({ mode, path: prefix + name, id: raw.subarray(nul + 1, nul + 21).toString('hex') });
    offset = nul + 21;
  }
  return entries;
}

function splitOnce(text) { const space = text.indexOf(' '); return [text.slice(0, space), text.slice(space + 1)]; }

async function readPatches(manifest, patchRoot) {
  return Promise.all(manifest.patches.map(async ({ path, sha256: expected }) => {
    const bytes = await readFile(join(patchRoot, path));
    if (sha256(bytes) !== expected) throw new Error(`Patch ${path} does not match its declared hash`);
    return { path, sha256: expected, bytes };
  }));
}

async function assemble(target, files, patches, manifest) {
  const source = join(target, 'source');
  for (const [path, { mode, bytes }] of files) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), bytes, { flag: 'wx', mode: mode === '100755' ? 0o755 : 0o644 });
  }
  // No repository exists at or above the output, so apply reads no repo config or attributes.
  for (const patch of patches) git(source, ['apply', '--whitespace=nowarn', '-'], { input: patch.bytes, env: { ...gitEnv, GIT_CEILING_DIRECTORIES: target } });
  const inventory = await sourceInventory(source);
  if (inventory.get('Cargo.lock')?.sha256 !== manifest.cargoLockSha256) throw new Error('Patched Cargo.lock does not match the declared hash');
  const sourceInventorySha256 = inventoryDigest(inventory);
  if (sourceInventorySha256 !== manifest.sourceInventorySha256) throw new Error(`Patched source inventory ${sourceInventorySha256} does not match the declared hash`);
  const receipt = preparedReceipt(manifest, inventory);
  await writeJson(join(target, 'receipt.pending.json'), receipt);
  await rename(join(target, 'receipt.pending.json'), join(target, 'receipt.json'));
  return receipt;
}

function preparedReceipt(manifest, inventory) {
  return { schema: 1, complete: true, repository: manifest.repository, revision: manifest.revision, cargoLockSha256: manifest.cargoLockSha256,
    patches: manifest.patches.map(({ path, sha256: hash }) => ({ path, sha256: hash })), sourceFiles: inventory.size, sourceInventorySha256: manifest.sourceInventorySha256, compiled: false, qualified: false };
}

// A receipt only names what to expect: the tree itself is re-hashed against the manifest.
export async function verifyPreparedSource(prepared, manifest) {
  validateManifest(manifest);
  if (!(await lstat(prepared)).isDirectory() || (await readdir(prepared)).sort().join('/') !== 'receipt.json/source') throw new Error('Prepared source must be a directory holding only receipt.json and source');
  const receipt = await readRegularJson(join(prepared, 'receipt.json'));
  if (!(await lstat(join(prepared, 'source'))).isDirectory()) throw new Error('Prepared source must be an ordinary directory');
  const inventory = await sourceInventory(join(prepared, 'source'));
  if (inventory.get('Cargo.lock')?.sha256 !== manifest.cargoLockSha256 || inventoryDigest(inventory) !== manifest.sourceInventorySha256) throw new Error('Prepared source tree does not match the pinned manifest');
  if (!isDeepStrictEqual(receipt, preparedReceipt(manifest, inventory))) throw new Error('Prepared source receipt does not match the pinned manifest');
  return { receipt, inventory };
}

export async function readRegularJson(path, limit = 65536) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat(), error = new Error(`${basename(path)} must be a bounded regular file`);
    if (!info.isFile() || info.size > limit) throw error;
    const bytes = await file.readFile();
    if (bytes.length > limit) throw error;
    return JSON.parse(bytes.toString('utf8'));
  } finally { await file.close(); }
}

// Canonical full-path sorted lines: '<sha256> <644|755>  <path>\n'.
export const inventoryDigest = inventory => sha256([...inventory].map(([path, file]) => `${file.sha256} ${file.mode}  ${path}\n`).join(''));

export async function sourceInventory(source) {
  const inventory = new Map();
  for (const path of (await readdir(source, { recursive: true })).sort()) {
    const stats = await lstat(join(source, path));
    if (path.split(sep).some(part => part.toLowerCase() === '.git') || !(stats.isFile() || stats.isDirectory())) throw new Error(`Patched source has unsafe entry ${path}`);
    if (stats.isFile()) inventory.set(path.split(sep).join('/'), { sha256: sha256(await readFile(join(source, path))), mode: stats.mode & 0o111 ? '755' : '644' });
  }
  return inventory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/runtime-source.mjs LOCAL_CELLD_REPOSITORY NEW_OUTPUT_DIRECTORY');
  const manifest = JSON.parse(await readFile(join(root, 'docker/runtime-source.json'), 'utf8'));
  const receipt = await prepareRuntimeSource({ repository: resolve(process.argv[2]), output: process.argv[3], manifest });
  console.log(`Prepared source ${receipt.revision} + ${receipt.patches.length} patches: ${receipt.sourceInventorySha256}. Not compiled or qualified.`);
}
