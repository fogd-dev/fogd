import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheDirectory, identity } from './paths.mjs';

const pending = new Map();
export async function withBuildLock(home, app, id, work) {
  identity(app, id);
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Host build retention requires a supported POSIX host and local filesystem');
  const directory = await cacheDirectory(home, ['build-locks', app], true), path = join(directory, `${id}.sqlite`);
  const previous = pending.get(path) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => locked(path, work)); pending.set(path, task);
  try { return await task; }
  finally { if (pending.get(path) === task) pending.delete(path); }
}
async function locked(path, work) {
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { const info = await file.stat(); if (!info.isFile() || info.nlink !== 1) throw new Error('Unsupported build lock file'); }
  finally { await file.close(); }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    try { db.exec('BEGIN IMMEDIATE'); }
    catch { throw new Error('Cannot lock this build; another operation may be running or the local lock database is unavailable'); }
    return await work();
  } finally { db.close(); }
}
