import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { writeAtomicFile } from './atomic-file.mjs';
import { decodeRouteRecord, encodeRouteRecord, maxRouteRecordBytes } from '@fogd/runtime/route-record';

export const routeRecordDigest = (record, policy) => createHash('sha256').update(encodeRouteRecord(record, policy)).digest('hex');
export async function readRouteRecord(path, policy) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxRouteRecordBytes) throw new Error('Invalid route authority file');
    const buffer = Buffer.alloc(maxRouteRecordBytes + 1); let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, bytes);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > maxRouteRecordBytes) throw new Error('Invalid route authority file');
    const content = buffer.subarray(0, bytes), text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    return { record: decodeRouteRecord(text, policy), digest: createHash('sha256').update(content).digest('hex') };
  } finally { await file.close(); }
}

async function publishRecord(path, record, policy, createOnly) {
  const directory = await lstat(dirname(path));
  if (!directory.isDirectory() || !(directory.mode & 0o001)) throw new Error('Authority mount must be an existing gateway-traversable directory');
  return writeAtomicFile(path, encodeRouteRecord(record, policy), { mode: 0o644, createOnly, createDirectory: false });
}
export const writeRouteRecord = (path, record, policy) => publishRecord(path, record, policy, false);
export const createRouteRecord = (path, record, policy) => publishRecord(path, record, policy, true);
