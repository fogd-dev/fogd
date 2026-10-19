import { constants } from 'node:os';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function saveJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export function storageFailureDiagnostic(error) {
  const syscalls = new Set(['open', 'write', 'rename', 'fsync', 'fdatasync', 'mkdir', 'close']);
  return { code: Object.hasOwn(constants.errno, error?.code) ? error.code : 'UNKNOWN', syscall: syscalls.has(error?.syscall) ? error.syscall : 'unknown' };
}
