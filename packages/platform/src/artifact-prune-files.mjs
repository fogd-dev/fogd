import { constants } from 'node:fs';
import { lstat, open, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectRetainedArtifact } from './artifact-inventory.mjs';
import { validatePruneTargets } from './artifact-prune-manifest.mjs';

function failure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
const refused = () => failure('Cannot prune retained artifacts; artifact contents no longer match the approved removal', 'ARTIFACT_PRUNE_REFUSED');
const incomplete = () => failure('Artifact pruning stopped before completion; remaining approved artifact data was kept', 'ARTIFACT_PRUNE_INCOMPLETE');
const missing = error => error?.code === 'ENOENT';

async function present(path) {
  try { return await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
}

// Observed entries must be a subset of the approved manifest with identical bytes and hashes.
async function preflight(root, target) {
  const info = await present(join(root, target.id));
  if (!info) return null;
  if (!info.isDirectory()) throw refused();
  const row = await inspectRetainedArtifact(root, target.id);
  const files = new Map(target.files.map(file => [file.path, file])), directories = new Set(target.directories);
  for (const file of row.files) if (files.get(file.path)?.sha256 !== file.sha256 || files.get(file.path).bytes !== file.bytes) throw refused();
  if (!row.directories.every(path => directories.has(path))) throw refused();
  return row;
}

// The artifacts root and every ancestor of the entry must still be real directories, not links.
async function ancestorsAreDirectories(root, names) {
  let dir = root;
  for (const name of ['', ...names]) {
    dir = join(dir, name);
    if (!(await lstat(dir)).isDirectory()) throw refused();
  }
}
const ancestors = (id, path) => [id, ...path.split('/').slice(0, -1)];

async function removeFile(root, id, file) {
  await ancestorsAreDirectories(root, ancestors(id, file.path));
  const info = await present(join(root, id, file.path));
  if (!info) return;
  if (!info.isFile() || info.nlink !== 1 || info.size !== file.bytes) throw refused();
  await unlink(join(root, id, file.path)).catch(error => { if (!missing(error)) throw error; });
}

async function removeDirectory(root, id, path) {
  await ancestorsAreDirectories(root, ancestors(id, path));
  await rmdir(join(root, id, path)).catch(error => { if (!missing(error)) throw error; });
}

// Only observed approved files are unlinked; directories go deepest first (reverse sort puts children
// before their prefix), then the release directory. rmdir refuses anything left behind.
async function removeTarget(root, row) {
  for (const file of row.files) await removeFile(root, row.id, file);
  for (const path of [...row.directories].reverse()) await removeDirectory(root, row.id, path);
  await ancestorsAreDirectories(root, []);
  await rmdir(join(root, row.id));
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// The caller persists the approved targets first and serializes controller writers; this does not fence
// external writers. Removed inner directories need no sync; the artifacts-root sync makes absence durable.
export async function removeApprovedArtifacts(root, targets) {
  validatePruneTargets(targets);
  let rows;
  try {
    if (!(await lstat(root)).isDirectory()) throw refused();
    rows = [];
    for (const target of targets) rows.push(await preflight(root, target));
  } catch { throw refused(); }
  try {
    for (const row of rows) if (row) await removeTarget(root, row);
    await syncDirectory(root);
  } catch (error) {
    throw error?.code === 'ARTIFACT_PRUNE_REFUSED' ? error : incomplete();
  }
}
