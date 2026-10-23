import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// Private host directory primitives shared by host records. Failures carry only a reason;
// callers map them into their own errors so raw causes and paths never leak.
export class HostDirectoryError extends Error {
  constructor(reason) { super('Host directory check failed'); this.name = 'HostDirectoryError'; this.reason = reason; }
}
const fail = reason => { throw new HostDirectoryError(reason); };
const MESSAGES = {
  path: 'directory must be an absolute path', unavailable: 'directory is unavailable',
  private: 'directory must be an existing private directory owned by the current user',
};
// Caller-facing text for a bind failure, e.g. 'Enrollment directory is unavailable'.
export const hostDirectoryMessage = (label, error) => `${label} ${MESSAGES[error.reason]}`;
const isPrivate = info => info.isDirectory() && (info.mode & 0o7777) === 0o700 && info.uid === process.geteuid();

// Reasons: 'path' (not absolute), 'unavailable', 'private' (not an owned 0700 directory).
export async function bindHostDirectory(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) fail('path');
  let info, canonical;
  try { info = await lstat(directory); canonical = await realpath(directory); }
  catch { fail('unavailable'); }
  if (!isPrivate(info)) fail('private');
  return { canonical, dev: info.dev, ino: info.ino };
}
// Any failure, including raw filesystem errors, means the bound directory changed.
export async function checkHostDirectory(bound) {
  try {
    const info = await lstat(bound.canonical);
    if (isPrivate(info) && info.dev === bound.dev && info.ino === bound.ino && await realpath(bound.canonical) === bound.canonical) return;
  } catch {}
  fail('changed');
}
export async function syncHostDirectory(bound) {
  try {
    const handle = await open(bound.canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (info.dev !== bound.dev || info.ino !== bound.ino) throw new Error('replaced');
      await handle.sync();
    } finally { await handle.close(); }
  } catch { fail('changed'); }
}
