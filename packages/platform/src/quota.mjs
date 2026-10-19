import { stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { regularFiles } from '@fogd/runtime/artifact';

export function positiveLimit(value, name) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error(`${name} must be a positive safe integer`);
  return limit;
}
export function uploadBytes(body) {
  if (!Array.isArray(body?.files) || body.files.some(file => typeof file?.data !== 'string')) throw new Error('Invalid artifact files');
  return body.files.reduce((sum, file) => sum + Buffer.byteLength(file.data, 'base64'), 0);
}
export class ArtifactQuota {
  constructor(limit) { this.limit = positiveLimit(limit, 'Artifact byte limit'); this.used = 0; this.unreferenced = []; }
  async init(dir, deployments = {}) {
    this.used = 0;
    const unreferenced = new Set();
    try {
      for (const path of await regularFiles(dir)) {
        this.used += (await stat(join(dir, path))).size;
        const id = path.split(sep)[0];
        if (!Object.hasOwn(deployments, id)) unreferenced.add(id);
      }
      this.unreferenced = [...unreferenced].sort();
    } catch { throw new Error('Cannot account for retained artifacts; inspect the controller artifacts directory and restore consistent storage'); }
  }
  admit(bytes) {
    if (this.used + bytes > this.limit) throw new Error('Retained artifact capacity reached; ask an administrator to review storage');
  }
  describe() { return { retainedArtifactBytes: this.used, maxArtifactBytes: this.limit, unreferencedArtifactIds: [...this.unreferenced] }; }
}
