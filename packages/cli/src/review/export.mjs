import { isDeepStrictEqual } from 'node:util';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { configEnv, serverOrigin } from '../local.mjs';
import { readAdminSnapshot } from '../inspect-command.mjs';
import { uuid, exists, privateJSON, controllerOrigin } from '../build-cache/paths.mjs';
import { reviewSelection } from './selection.mjs';
import { downloadReviewArtifact } from './artifact.mjs';
import { artifactComparison } from '@fogd/platform/artifact-comparison';

export async function exportArtifactReview(id, destination) {
  if (!uuid(id) || typeof destination !== 'string' || !destination) throw new Error('A submission ID and fresh review directory are required');
  const path = resolve(destination), output = join(await realpath(dirname(path)), basename(path));
  if (await exists(output)) throw new Error('Review output already exists; retain it and choose a fresh private directory');
  const env = await configEnv(); env.FOGD_SERVER = controllerOrigin(serverOrigin(env));
  const selected = reviewSelection(await readAdminSnapshot(env), id);
  const authorization = `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER || 'admin'}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`;
  await mkdir(output, { mode: 0o700 });
  const proposed = await downloadReviewArtifact(env.FOGD_SERVER, authorization, selected.view.app, selected.view.proposed, join(output, 'proposed'));
  const active = selected.view.active ? await downloadReviewArtifact(env.FOGD_SERVER, authorization, selected.view.app, selected.view.active, join(output, 'active')) : null;
  const current = reviewSelection(await readAdminSnapshot(env), id);
  if (!isDeepStrictEqual(current.guard, selected.guard) || !isDeepStrictEqual(current.view, selected.view)) throw new Error('Application or submission state changed during review; retain the copies and create a fresh review before deciding');
  const report = { schema: 1, completedAt: new Date().toISOString(), ...selected.view, comparison: artifactComparison(active, proposed),
    directories: { proposed: 'proposed', active: active ? 'active' : null },
    scope: 'Artifact comparison only. This does not execute code, predict SQL effects, prove runtime health, or authorize approval. Approval rechecks controller state and pauses new HTTP routing.' };
  await privateJSON(join(output, 'review.json'), report);
  return { origin: env.FOGD_SERVER, directory: output, report };
}
