import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { checkHostDirectory } from '../runtime/host-directory.mjs';
import { previewInputFile } from './input-files.mjs';
import { hash, jsonBytes } from '../build-cache/paths.mjs';

// Read bounded owner-only bytes without following links. The
// caller supplies the independently retained fingerprint when one is required.
async function fileSource(bound, name, limit, expected) {
  await checkHostDirectory(bound);
  const path = join(bound.canonical, name), before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== process.geteuid() || (before.mode & 0o7777) !== 0o600 || before.size > limit) throw new Error('Private preview record refused');
  const bytes = await previewInputFile(path, limit), after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs || before.size !== after.size) throw new Error('Private preview record changed');
  await checkHostDirectory(bound);
  const sha256 = hash(bytes);
  if (expected !== undefined && sha256 !== expected) throw new Error('Private preview fingerprint refused');
  return { bytes, sha256, identity: { device: before.dev, inode: before.ino } };
}

export async function readPrivatePreviewFile(bound, name, limit, expected) {
  return (await fileSource(bound, name, limit, expected)).bytes;
}

export async function readPrivatePreviewRecordSource(bound, name, limit, expected) {
  const source = await fileSource(bound, name, limit, expected), value = JSON.parse(source.bytes);
  if (!source.bytes.equals(Buffer.from(jsonBytes(value)))) throw new Error('Private preview metadata refused');
  return { value, sha256: source.sha256, bytes: source.bytes.length, identity: source.identity };
}
export async function readPrivatePreviewRecord(bound, name, limit, expected) {
  return (await readPrivatePreviewRecordSource(bound, name, limit, expected)).value;
}
