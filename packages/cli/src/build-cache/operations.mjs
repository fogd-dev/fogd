import { randomUUID } from 'node:crypto';
import { readdir, realpath, rename, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheDirectory, exists, hash, jsonBytes, readPrivateJSON, atomicJSON, syncDirectory, identity, uuid, digest } from './paths.mjs';
import { validateCandidate } from './schema.mjs';
import { retentionReason } from './policy.mjs';
import { buildTree, assertTreeSubset } from './tree.mjs';
import { withBuildLock } from './mutex.mjs';

async function locations(home, app, id) {
  const cache = await cacheDirectory(home, ['build-cache', app]), trash = await cacheDirectory(home, ['build-trash', app]);
  const source = cache && join(cache, id), moved = trash && join(trash, id);
  return { source, trash: moved, present: source && await exists(source), moved: moved && await exists(moved) };
}
async function savedOperation(home, app, id) {
  const directory = await cacheDirectory(home, ['build-prunes', app]);
  if (!directory || !await exists(join(directory, `${id}.json`))) return null;
  const { value } = await readPrivateJSON(join(directory, `${id}.json`), 16 * 1024 ** 2), body = value?.body;
  if (!body || value.checksum !== hash(jsonBytes(body)) || body.format !== 'fogd-host-cache-prune-v1' || body.home !== hash(await realpath(home)) || !digest(body.planHash) || !digest(body.controller)) throw new Error('Saved prune operation is unsupported or changed');
  validateCandidate(body.row);
  if (body.row.app !== app || body.row.id !== id) throw new Error('Saved prune operation identifies a different build');
  return body;
}
async function prepareOperation(home, row, scope) {
  const old = await preparedOperation(home, row.app, row.id);
  if (old) {
    if (hash(jsonBytes(old.row)) === hash(jsonBytes(row))) return old;
    // Caller holds the build lock and verified a fresh plan against the complete
    // cache tree, with no trash present. No deletion began under the old grant.
  }
  const directory = await cacheDirectory(home, ['build-prunes', row.app], true);
  const body = { format: 'fogd-host-cache-prune-v1', ...scope, row };
  await atomicJSON(join(directory, `${row.id}.json`), { body, checksum: hash(jsonBytes(body)) });
  return body;
}
// Only called after a fresh plan, current terminal receipt and complete cache tree
// have been verified under the lock, with no trash present. Preserve damaged
// metadata separately rather than discarding bytes or adopting it as authority.
async function preparedOperation(home, app, id) {
  try { return await savedOperation(home, app, id); }
  catch {
    const directory = await cacheDirectory(home, ['build-prunes', app]), file = directory && join(directory, `${id}.json`);
    const info = file && await exists(file);
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw new Error('Prepared prune metadata is unsupported; preserve it and inspect locally');
    const history = await cacheDirectory(home, ['build-prunes', app, 'history'], true);
    await rename(file, join(history, `${id}-${randomUUID()}.json`));
    await syncDirectory(history); await syncDirectory(directory);
    return null;
  }
}
export async function pruneCandidate(home, row, scope, origin, state) {
  return withBuildLock(home, row.app, row.id, async () => {
    const where = await locations(home, row.app, row.id);
    if (where.present && where.moved) throw new Error('Both cache and trash contain this build; preserve them and inspect locally');
    if (!where.present && !where.moved) return { app: row.app, id: row.id, alreadyAbsent: true };
    if (where.moved) return finishSaved(home, row.app, row.id, where);
    if (await exists(join(where.source, 'keep'))) return { app: row.app, id: row.id, kept: true, reason: 'operator-kept' };
    const reason = retentionReason(row.record, await state(), origin);
    if (reason !== 'terminal-copy') return { app: row.app, id: row.id, kept: true, reason };
    const tree = await buildTree(where.source, true); assertTreeSubset(tree, row.tree, true);
    await prepareOperation(home, row, scope);
    const trashParent = await cacheDirectory(home, ['build-trash', row.app], true), target = join(trashParent, row.id);
    await rename(where.source, target);
    await syncDirectory(trashParent); await syncDirectory(await cacheDirectory(home, ['build-cache', row.app]));
    return finishSaved(home, row.app, row.id, { source: where.source, trash: target, present: null, moved: true }, false);
  });
}
async function finishSaved(home, app, id, where, resumed = true) {
  const operation = await savedOperation(home, app, id);
  if (!operation) throw new Error('Trash has no saved approved operation; its data was preserved');
  const row = operation.row;
  if (await exists(join(where.trash, 'keep'))) return { app, id, kept: true, reason: 'operator-kept' };
  const verified = await buildTree(where.trash, true); assertTreeSubset(verified, row.tree);
  const files = verified.files.sort((a, b) => Number(a.path === 'record.json') - Number(b.path === 'record.json'));
  for (const file of files) await unlink(join(where.trash, file.path));
  for (const directory of [...verified.directories].sort((a, b) => b.split('/').length - a.split('/').length)) await rmdir(join(where.trash, directory));
  await rmdir(where.trash); await syncDirectory(await cacheDirectory(home, ['build-trash', app]));
  return { app, id, completed: true, resumed, logicalBytes: row.logicalBytes };
}
export async function resumePrune(home, app, id) {
  identity(app, id);
  if (!await savedOperation(home, app, id)) throw new Error('No saved prune operation exists for this build');
  return withBuildLock(home, app, id, async () => {
    const where = await locations(home, app, id);
    if (where.present && where.moved) throw new Error('Both cache and trash contain this build; preserve them and inspect locally');
    if (where.present) return { app, id, kept: true, reason: 'Review a new plan before starting a prepared operation' };
    if (!where.moved) return { app, id, alreadyAbsent: true };
    return finishSaved(home, app, id, where);
  });
}
export async function unfinishedPrunes(home, app) {
  const directory = await cacheDirectory(home, ['build-trash', app]);
  if (!directory) return [];
  const rows = [];
  for (const id of (await readdir(directory)).sort()) {
    if (!uuid(id)) { rows.push({ journalAvailable: false, reason: 'Unrecognized trash entry preserved' }); continue; }
    try {
      const operation = await savedOperation(home, app, id), tree = await buildTree(join(directory, id));
      rows.push({ app, id, journalAvailable: Boolean(operation), logicalBytesRemaining: tree.logicalBytes });
    } catch { rows.push({ app, id, journalAvailable: false, reason: 'Changed or unsupported trash preserved' }); }
  }
  return rows;
}
