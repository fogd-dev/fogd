import { createHash } from 'node:crypto';
import { MAX_UPLOAD } from '../../packages/runtime/src/manifest.mjs';

export function paddedUpload(original) {
  const artifact = structuredClone(original), files = artifact.files;
  if (files.some(file => /^assets\/capacity(?:-\d+)?\.bin$/.test(file.path))) throw new Error('Capacity padding already exists');
  const used = files.reduce((sum, file) => sum + Buffer.from(file.data, 'base64').length, 0);
  if (used >= MAX_UPLOAD) throw new Error('No room for capacity padding');
  let remaining = MAX_UPLOAD - used, part = 0;
  while (remaining > 0) {
    const size = Math.min(remaining, 16 * 1024 ** 2);
    files.push({ path: `assets/capacity-${part++}.bin`, data: Buffer.alloc(size, 97).toString('base64') }); remaining -= size;
  }
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : 1)) {
    const bytes = Buffer.from(file.data, 'base64'); hash.update(JSON.stringify([file.path, bytes.length])); hash.update(bytes);
  }
  artifact.digest = hash.digest('hex');
  return { payload: JSON.stringify(artifact), artifactBytes: MAX_UPLOAD, digest: artifact.digest };
}
