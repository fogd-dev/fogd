import { constants } from 'node:os';
import { readFile } from 'node:fs/promises';
import { writeAtomicFile } from './atomic-file.mjs';

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export const saveJson = (path, value) => writeAtomicFile(path, JSON.stringify(value, null, 2));

export function storageFailureDiagnostic(error) {
  const syscalls = new Set(['open', 'write', 'rename', 'fsync', 'fdatasync', 'mkdir', 'close', 'link', 'unlink', 'chmod', 'fchmod', 'read']);
  return { code: Object.hasOwn(constants.errno, error?.code) ? error.code : 'UNKNOWN', syscall: syscalls.has(error?.syscall) ? error.syscall : 'unknown' };
}
