// Standalone trust bootstrap: only Node built-ins, also reused by the CLI.
import { constants } from 'node:fs';
import { open, readdir, lstat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const transferFormat = 'fogd-runtime-transfer-v1';
export const clientFormat = 'fogd-client-bundle-v1';
export const ignoreFiles = ['LICENSE-MIT', 'README.md', 'index.d.ts', 'index.js', 'legacy.js', 'package.json'];
export const clientModules = {
  cli: ['client/main', 'deploy-command', 'local', 'build', 'build-env', 'build-cache/lifecycle', 'build-cache/paths', 'deploy-capabilities', 'client-http', 'status-command', 'submitter-status'],
  runtime: ['artifact', 'assets', 'files', 'manifest', 'deployment', 'queues', 'crons'],
  platform: ['deployment-status', 'runtime-policy', 'runtime-identity-proof'],
};
export function clientProgramPaths() {
  return [...ignoreFiles.map(name => `node_modules/ignore/${name}`), ...Object.entries(clientModules).flatMap(([name, modules]) => {
    const base = name === 'cli' ? 'packages/cli' : `node_modules/@fogd/${name}`;
    return [`${base}/package.json`, ...modules.map(path => `${base}/src/${path}.mjs`)];
  })];
}
const profiles = {
  [transferFormat]: { roots: ['images.tar', 'verify-transfer.mjs'] },
  [clientFormat]: { roots: ['fogd.mjs', 'verify-client.mjs'] },
};
export async function ordinaryDirectory(path) {
  if (!(await lstat(path)).isDirectory()) throw new Error('Transfer paths must be ordinary directories');
}
export async function transferFiles(root, prefix = '') {
  await ordinaryDirectory(join(root, prefix));
  const files = [];
  const names = (await readdir(join(root, prefix))).sort();
  if (prefix && !names.length) throw new Error('Empty directories are not transfer members');
  for (const name of names) {
    const path = prefix ? `${prefix}/${name}` : name, info = await lstat(join(root, path));
    if (info.isDirectory()) files.push(...await transferFiles(root, path));
    else if (info.isFile()) files.push(path);
    else throw new Error('Transfer inputs must be regular files and directories without symlinks');
  }
  return files.sort();
}
export async function transferFingerprint(path, limit = 32 * 1024 ** 3) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('Transfer file is not regular or exceeds its size limit');
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) { hash.update(chunk); bytes += chunk.length; }
    if (bytes !== info.size) throw new Error('Transfer input changed while reading');
    return { bytes, sha256: hash.digest('hex') };
  } finally { await file.close(); }
}

export async function verifyTransferFiles(directory, expectedManifest) {
  return verifyBundleFiles(directory, expectedManifest, transferFormat);
}
export async function verifyClientFiles(directory, expectedManifest) {
  const manifest = await verifyBundleFiles(directory, expectedManifest, clientFormat);
  const expected = [...profiles[clientFormat].roots, ...clientProgramPaths().map(path => `program/${path}`)].sort();
  if (!isDeepStrictEqual(Object.keys(manifest).sort(), ['files', 'format']) || !isDeepStrictEqual(Object.keys(manifest.files).sort(), expected)) throw new Error('Invalid developer client inventory');
  return manifest;
}
async function verifyBundleFiles(directory, expectedManifest, format) {
  if (!/^[a-f0-9]{64}$/.test(expectedManifest || '')) throw new Error('Transfer requires an independently retained manifest SHA256');
  await ordinaryDirectory(directory);
  const manifest = await readManifest(join(directory, 'manifest.json'), expectedManifest);
  if (!manifest || manifest.format !== format || !manifest.files || Array.isArray(manifest.files) || Object.keys(manifest.files).length > 2048) throw new Error('Unsupported transfer inventory');
  if (!isDeepStrictEqual(await transferFiles(directory), [...Object.keys(manifest.files), 'manifest.json'].sort())) throw new Error('Transfer has missing or unexpected members');
  for (const [path, expected] of Object.entries(manifest.files)) {
    if (!safePath(path, profiles[format].roots) || !validTransferFingerprint(expected)) throw new Error('Invalid transfer member or fingerprint');
    if (!isDeepStrictEqual(await transferFingerprint(join(directory, path), path === 'images.tar' ? 32 * 1024 ** 3 : 4 * 1024 ** 2), expected)) throw new Error('Transfer member checksum differs');
  }
  return manifest;
}
export function validTransferFingerprint(value) {
  return value && isDeepStrictEqual(Object.keys(value).sort(), ['bytes', 'sha256']) && Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 && value.bytes <= 32 * 1024 ** 3 && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256);
}
export function parseTransferJson(text) {
  try { return JSON.parse(text); }
  catch { throw new Error('Unreadable transfer metadata; contents are not displayed'); }
}
export async function readTransferMetadata(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4 * 1024 ** 2) throw new Error('Transfer metadata must be a bounded regular file');
    return parseTransferJson(await file.readFile('utf8'));
  } finally { await file.close(); }
}
function safePath(path, roots) {
  return path.length <= 248 && /^[A-Za-z0-9@._/-]+$/.test(path) && path.split('/').every(part => part && part !== '.' && part !== '..') &&
    (roots.includes(path) || path.startsWith('program/'));
}
async function readManifest(path, expected) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4 * 1024 ** 2) throw new Error('Transfer manifest must be a bounded regular file');
    const text = await file.readFile('utf8');
    if (createHash('sha256').update(text).digest('hex') !== expected) throw new Error('Transfer manifest checksum differs');
    const value = parseTransferJson(text);
    if (JSON.stringify(value, null, 2) + '\n' !== text) throw new Error('Transfer manifest must use the exporter canonical JSON format');
    return value;
  } finally { await file.close(); }
}
if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node verify-transfer.mjs DIRECTORY EXPECTED_MANIFEST_SHA256');
    const verify = basename(process.argv[1]) === 'verify-client.mjs' ? verifyClientFiles : verifyTransferFiles;
    const manifest = await verify(resolve(process.argv[2]), process.argv[3]);
    console.log(JSON.stringify({ verifiedFiles: Object.keys(manifest.files).length, dockerContacted: false }));
  } catch (error) { console.error(`Transfer verification failed: ${error.message}`); process.exitCode = 1; }
}
