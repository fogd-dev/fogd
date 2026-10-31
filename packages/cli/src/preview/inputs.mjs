import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { receiveArtifact } from '@fogd/runtime/manifest';
import { artifactComparison } from '@fogd/platform/artifact-comparison';
import { validatePreviewPreparation } from './execution.mjs';
import { executionKeys, executionTimestamp, refuseExecution } from './execution-shape.mjs';
import { previewInputJSON, previewInputDirectory, previewArtifactInput } from './input-files.mjs';

async function verifiedArtifact(root, name, app, expected) {
  const input = await previewArtifactInput(join(root, name), app, expected.digest);
  const temporary = await mkdtemp(join(tmpdir(), 'fogd-preview-verify-'));
  try {
    const copy = join(temporary, 'artifact'); await mkdir(copy, { mode: 0o700 });
    // Validate declarations and digests without executing SQL or worker code.
    const release = await receiveArtifact(input.body, copy, { cronApps: true });
    return { release, files: input.fingerprints, artifact: input.body };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

function checkedReview(review, preparation) {
  executionKeys(review, ['schema', 'completedAt', 'app', 'proposed', 'active', 'context', 'comparison', 'directories', 'scope']);
  if (review.schema !== 1 || review.app !== preparation.source.app || review.proposed?.id !== preparation.source.submission ||
    review.proposed?.digest !== preparation.source.digest || !['pending', 'failed'].includes(review.proposed?.status) ||
    executionTimestamp(review.completedAt) > executionTimestamp(preparation.preparedAt)) refuseExecution();
  if (!isDeepStrictEqual(review.directories, { proposed: 'proposed', active: review.active ? 'active' : null })) refuseExecution();
}

export async function readPreviewPreparation(directory, expectedPreparationSha256) {
  try {
    const root = resolve(directory); await previewInputDirectory(root, true);
    const preparation = await previewInputJSON(join(root, 'preview.json'), 16384, expectedPreparationSha256);
    validatePreviewPreparation(preparation, expectedPreparationSha256);
    return { directory: root, preparation };
  } catch { refuseExecution(); }
}

// Snapshot actual bounded bytes into memory. Later allocation must use this
// verified artifact, never reopen the mutable preparation directory for launch.
export async function readPreviewInputs(directory, expectedPreparationSha256) {
  try {
    const { directory: root, preparation } = await readPreviewPreparation(directory, expectedPreparationSha256);
    const review = await previewInputJSON(join(root, 'review.json'), 4 * 1024 ** 2, preparation.source.reviewSha256);
    checkedReview(review, preparation);
    const names = ['preview.json', 'review.json', 'proposed', ...(review.active ? ['active'] : [])].sort();
    if (!isDeepStrictEqual((await readdir(root)).sort(), names)) refuseExecution();
    const proposed = await verifiedArtifact(root, 'proposed', review.app, review.proposed);
    const active = review.active ? await verifiedArtifact(root, 'active', review.app, review.active) : null;
    if (!isDeepStrictEqual(artifactComparison(active, proposed), review.comparison)) refuseExecution();
    if (!isDeepStrictEqual(proposed.release.requiredSecrets, preparation.policy.requiredSecrets)) refuseExecution();
    return { preparation, review, artifact: proposed.artifact, release: proposed.release };
  } catch { refuseExecution(); }
}
