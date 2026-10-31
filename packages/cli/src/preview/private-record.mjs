import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { checkHostDirectory } from '../runtime/host-directory.mjs';
import { previewInputFile } from './input-files.mjs';
import { hash, jsonBytes } from '../build-cache/paths.mjs';

// Read bounded owner-only bytes without following links. The
// caller supplies the independently retained fingerprint when one is required.
export async function readPrivatePreviewFile(bound, name, limit, expected) {
  await checkHostDirectory(bound);
  const path = join(bound.canonical, name), before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== process.geteuid() || (before.mode & 0o7777) !== 0o600 || before.size > limit) throw new Error('Private preview record refused');
  const bytes = await previewInputFile(path, limit), after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs || before.size !== after.size) throw new Error('Private preview record changed');
  await checkHostDirectory(bound);
  if (expected !== undefined && hash(bytes) !== expected) throw new Error('Private preview fingerprint refused');
  return bytes;
}

export async function readPrivatePreviewRecord(bound, name, limit, expected) {
  const bytes = await readPrivatePreviewFile(bound, name, limit, expected), value = JSON.parse(bytes);
  if (!bytes.equals(Buffer.from(jsonBytes(value)))) throw new Error('Private preview metadata refused');
  return value;
}
