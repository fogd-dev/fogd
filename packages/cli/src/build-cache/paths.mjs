import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appName } from '@fogd/runtime/artifact';

export const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const hash = value => createHash('sha256').update(value).digest('hex');
export const jsonBytes = value => JSON.stringify(value, null, 2) + '\n';
export function identity(app, id) {
  appName(app);
  if (!uuid(id)) throw new Error('Local build ID must be a UUID');
}
export async function exists(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function cacheDirectory(home, parts, create = false) {
  let path = await realpath(home);
  for (const part of ['.fogd', ...parts]) {
    path = join(path, part);
    if (create) {
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const info = await exists(path);
    if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Build cache requires real directories below its home');
  }
  return path;
}
export async function readPrivateJSON(path, limit = 16384) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('Unsupported local metadata file');
    const bytes = await file.readFile();
    if (bytes.length > limit) throw new Error('Local metadata exceeds its size bound');
    let value;
    try { value = JSON.parse(bytes); } catch { throw new Error('Local metadata JSON is unreadable'); }
    return { value, bytes };
  } finally { await file.close(); }
}
export async function privateJSON(path, value) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(jsonBytes(value)); await file.sync(); }
  finally { await file.close(); }
}
export async function recordBuild(directory, value) {
  const temporary = join(directory, `.record-${randomUUID()}.tmp`);
  await privateJSON(temporary, value);
  await rename(temporary, join(directory, 'record.json')); await syncDirectory(directory);
}
export function controllerOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Use a valid controller HTTP(S) endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Controller endpoint must not contain credentials, query or fragment');
  return url.href.replace(/\/$/, '');
}

export async function syncDirectory(path) {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function atomicJSON(path, value) {
  const parent = dirname(path), temporary = join(parent, `.operation-${randomUUID()}.tmp`);
  await privateJSON(temporary, value); await rename(temporary, path); await syncDirectory(parent);
}
