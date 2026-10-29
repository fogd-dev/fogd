import { constants } from 'node:fs';
import { open, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { regularFiles } from '@fogd/runtime/artifact';
import { receiveArtifact, MAX_UPLOAD } from '@fogd/runtime/manifest';

export class ReviewUnavailableError extends Error {
  constructor(status = 409, message = 'Artifact review is unavailable or differs from its recorded identity. Retain original data and inspect controller integrity.') {
    super(message); this.code = 'ARTIFACT_REVIEW_UNAVAILABLE'; this.status = status;
  }
}

export async function verifiedReviewArtifact(controller, id) {
  const expected = controller.state.deployments[id];
  if (!expected) throw new ReviewUnavailableError(404, 'The selected submission is unavailable.');
  if (expected.id !== id) throw new ReviewUnavailableError();
  if (expected.artifactPruned) throw new ReviewUnavailableError(410, 'Artifact bytes were pruned; deployment and decision history remain.');
  let temporary;
  try {
    const { body, files } = await boundedManifest(controller.artifact(id), expected);
    temporary = await mkdtemp(join(tmpdir(), 'fogd-review-'));
    const release = await receiveArtifact(body, temporary, { cronApps: true });
    for (const key of ['resources', 'migrations', 'requiredSecrets']) {
      if (!isDeepStrictEqual(release[key], expected[key] ?? (key === 'resources' ? null : []))) throw new ReviewUnavailableError();
    }
    return { body, files, release };
  } catch (error) {
    if (error instanceof ReviewUnavailableError) throw error;
    throw new ReviewUnavailableError();
  } finally {
    if (temporary) {
      try { await rm(temporary, { recursive: true, force: true }); }
      catch { throw new ReviewUnavailableError(503, 'Private review staging cleanup is unconfirmed; inspect local controller storage.'); }
    }
  }
}

async function boundedManifest(directory, expected) {
  const paths = (await regularFiles(directory)).filter(path => path !== 'fogd-release.json');
  if (paths.length < 2 || paths.length > 2000) throw new ReviewUnavailableError();
  const body = { app: expected.app, digest: expected.digest, files: [] }, files = []; let total = 0;
  for (const path of paths) {
    const data = await boundedFile(join(directory, path), MAX_UPLOAD - total); total += data.length;
    body.files.push({ path, data: data.toString('base64') });
    files.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  }
  return { body, files };
}

async function boundedFile(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new ReviewUnavailableError();
    const buffer = Buffer.alloc(info.size + 1); let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== info.size) throw new ReviewUnavailableError();
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}

export async function verifyReviewedDecision(controller, id) {
  await verifiedReviewArtifact(controller, id);
  const active = controller.state.apps[controller.state.deployments[id].app]?.active;
  if (active && active !== id) await verifiedReviewArtifact(controller, active);
}
