import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { checkHostDirectory } from '../runtime/host-directory.mjs';
import { previewInputJSON } from './input-files.mjs';

// Read canonical, bounded owner-only metadata without following links. The
// caller supplies the independently retained fingerprint when one is required.
export async function readPrivatePreviewRecord(bound, name, limit, expected) {
  await checkHostDirectory(bound);
  const path = join(bound.canonical, name), before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== process.geteuid() || (before.mode & 0o7777) !== 0o600 || before.size > limit) throw new Error('Private preview record refused');
  const value = await previewInputJSON(path, limit, expected), after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs || before.size !== after.size) throw new Error('Private preview record changed');
  await checkHostDirectory(bound);
  return value;
}
