import { constants } from 'node:fs';
import { open, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_UPLOAD } from '@fogd/runtime/manifest';
import { hash } from '../build-cache/paths.mjs';
import { refuseExecution } from './execution-shape.mjs';

export async function previewInputFile(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) refuseExecution();
    const chunks = []; let length = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      length += chunk.length; if (length > limit) refuseExecution(); chunks.push(chunk);
    }
    const after = await file.stat({ bigint: true });
    if (before.size !== BigInt(length) || before.size !== after.size || before.ctimeNs !== after.ctimeNs) refuseExecution();
    return Buffer.concat(chunks);
  } finally { await file.close(); }
}

export async function previewInputDirectory(path, privateRoot = false) {
  const info = await lstat(path);
  if (!info.isDirectory() || (privateRoot && (info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700))) refuseExecution();
}

async function artifactFiles(root, prefix, budget) {
  await previewInputDirectory(join(root, prefix));
  const files = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (++budget.entries > 4000 || path.length > 512) refuseExecution();
    const info = await lstat(join(root, path));
    if (info.isDirectory()) files.push(...await artifactFiles(root, path, budget));
    else {
      const bytes = await previewInputFile(join(root, path), MAX_UPLOAD - budget.bytes);
      budget.bytes += bytes.length;
      files.push({ path, bytes });
      if (++budget.files > 2000) refuseExecution();
    }
  }
  if (!files.length) refuseExecution();
  return files;
}

export async function previewArtifactInput(directory, app, digest) {
  const files = (await artifactFiles(directory, '', { entries: 0, bytes: 0, files: 0 })).sort((a, b) => a.path.localeCompare(b.path));
  return { body: { app, digest, files: files.map(({ path, bytes }) => ({ path, data: bytes.toString('base64') })) },
    fingerprints: files.map(({ path, bytes }) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) };
}
