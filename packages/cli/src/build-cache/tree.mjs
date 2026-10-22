import { constants } from 'node:fs';
import { readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exists } from './paths.mjs';

export const safePath = value => typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..');
export async function buildTree(root, hashes = false) {
  const info = await exists(root);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error('Unsupported local build directory');
  const directories = [], entries = [];
  await visit(root, '', directories, entries);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); directories.sort();
  const artifact = createHash('sha256');
  for (const entry of entries) if (hashes) await fingerprint(root, entry, artifact);
  return { identity: { dev: String(info.dev), ino: String(info.ino) }, directories, files: entries,
    logicalBytes: entries.reduce((sum, value) => sum + value.bytes, 0), ...(hashes ? { artifactDigest: artifact.digest('hex') } : {}) };
}
async function visit(root, relative, directories, files) {
  for (const name of (await readdir(join(root, relative))).sort()) {
    const path = relative ? `${relative}/${name}` : name;
    if (!safePath(path)) throw new Error('Unsupported local build path');
    const info = await exists(join(root, path));
    if (!info || info.isSymbolicLink()) throw new Error('Changed or linked local build entry');
    if (info.isDirectory()) { directories.push(path); await visit(root, path, directories, files); }
    else {
      if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsupported local build entry');
      files.push({ path, bytes: Number(info.size) });
    }
  }
}
async function fingerprint(root, entry, artifact) {
  const file = await open(join(root, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(entry.bytes)) throw new Error('Local build changed while being read');
    const relative = entry.path.startsWith('artifact/') ? entry.path.slice(9) : null;
    const included = relative && relative !== 'fogd-release.json';
    if (included) artifact.update(JSON.stringify([relative, entry.bytes]));
    const hash = createHash('sha256');
    for await (const bytes of file.createReadStream({ autoClose: false })) { hash.update(bytes); if (included) artifact.update(bytes); }
    const after = await file.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ino !== before.ino) throw new Error('Local build changed while being read');
    entry.sha256 = hash.digest('hex');
  } finally { await file.close(); }
}
export function assertTreeSubset(current, expected, complete = false) {
  if (current.identity.dev !== expected.identity.dev || current.identity.ino !== expected.identity.ino) throw new Error('Build directory differs from the reviewed plan');
  const files = new Map(expected.files.map(file => [file.path, file])), directories = new Set(expected.directories);
  for (const file of current.files) {
    const old = files.get(file.path);
    if (!old || old.bytes !== file.bytes || old.sha256 !== file.sha256) throw new Error('Build contains changed or unreviewed data');
  }
  if (current.directories.some(path => !directories.has(path))) throw new Error('Build contains unreviewed directories');
  if (complete && (current.files.length !== expected.files.length || current.directories.length !== expected.directories.length)) throw new Error('Build differs from the reviewed plan');
}
