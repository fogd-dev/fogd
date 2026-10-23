import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const singleRegular = info => info.isFile() && info.nlink === 1;
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;

function refused() {
  const error = new Error('Cannot inventory retained artifacts; remove links, special files or unreadable entries from the controller artifacts directory');
  error.code = 'ARTIFACT_INVENTORY_REFUSED';
  return error;
}

// lstat before and after listing so a directory swapped for a link is refused.
async function listDirectory(dir) {
  const before = await lstat(dir);
  if (!before.isDirectory()) throw refused();
  const names = await readdir(dir);
  if (!sameNode(before, await lstat(dir))) throw refused();
  return names.sort();
}

async function regularPaths(root, prefix = '', directories = []) {
  const paths = [];
  for (const name of await listDirectory(join(root, prefix))) {
    const path = join(prefix, name);
    const info = await lstat(join(root, path));
    if (info.isDirectory()) { directories.push(path); paths.push(...await regularPaths(root, path, directories)); }
    else if (singleRegular(info)) paths.push(path);
    else throw refused();
  }
  return paths;
}

// O_NONBLOCK keeps a FIFO swapped in after lstat from blocking; fstat then refuses it.
async function readRegular(path, artifact = null) {
  const handle = await open(path, readFlags);
  try {
    const info = await handle.stat();
    if (!singleRegular(info) || !Number.isSafeInteger(info.size)) throw refused();
    if (artifact) artifact.hash.update(JSON.stringify([artifact.path, info.size]));
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > info.size) throw refused();
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk); artifact?.hash.update(chunk);
    }
    if (bytes !== info.size) throw refused();
    return { bytes, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

async function directoryRow(root, id) {
  const dir = join(root, id), digest = createHash('sha256'), files = [], directories = [];
  for (const path of (await regularPaths(dir, '', directories)).sort()) {
    const artifact = path === 'fogd-release.json' ? null : { hash: digest, path };
    files.push({ path, ...await readRegular(join(dir, path), artifact) });
  }
  return { id, kind: 'directory', bytes: files.reduce((sum, file) => sum + file.bytes, 0), digest: digest.digest('hex'), files, directories: directories.sort() };
}

async function fileRow(root, id) {
  const file = await readRegular(join(root, id));
  return { id, kind: 'file', bytes: file.bytes, digest: null, files: [{ path: '.', ...file }], directories: [] };
}

// One row per artifacts-root entry, sorted by id; digests and file hashes come from the same read.
export async function artifactInventory(dir) {
  try {
    const rows = [];
    for (const id of await listDirectory(dir)) {
      const info = await lstat(join(dir, id));
      if (info.isDirectory()) rows.push(await directoryRow(dir, id));
      else if (singleRegular(info)) rows.push(await fileRow(dir, id));
      else throw refused();
    }
    return rows;
  } catch { throw refused(); }
}
