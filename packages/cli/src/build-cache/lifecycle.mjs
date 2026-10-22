import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { stageArtifact } from '@fogd/runtime/artifact';
import { cacheDirectory, recordBuild, readPrivateJSON, controllerOrigin, identity, uuid } from './paths.mjs';

export async function stageManagedBuild(home, { app, project, settings, capabilities }) {
  const id = randomUUID(); identity(app, id);
  const parent = await cacheDirectory(home, ['build-cache', app], true), directory = join(parent, id);
  await mkdir(directory, { mode: 0o700 });
  const record = { schema: 1, app, id, phase: 'building' };
  await recordBuild(directory, record);
  const outputDir = join(directory, 'artifact');
  try {
    const release = await stageArtifact({ projectDir: project, outputDir, app, buildOutput: settings.buildOutput, migrationsDir: settings.migrationsDir, capabilities });
    await recordBuild(directory, { ...record, phase: 'staged', digest: release.digest });
    return { ...release, outputDir, localBuildId: id };
  } catch (error) {
    await recordBuild(directory, { ...record, phase: 'failed' }).catch(() => {});
    throw error;
  }
}

export async function submitManagedBuild(home, release, server, upload) {
  identity(release.app, release.localBuildId);
  const origin = controllerOrigin(server), directory = await cacheDirectory(home, ['build-cache', release.app, release.localBuildId]);
  if (!directory) throw new Error('Local build metadata is unavailable; rebuild before submitting');
  const { value: record } = await readPrivateJSON(join(directory, 'record.json'));
  if (record.schema !== 1 || record.app !== release.app || record.id !== release.localBuildId || record.phase !== 'staged' || record.digest !== release.digest) throw new Error('Local build differs from its staged receipt');
  const uploading = { ...record, phase: 'uploading', server: origin };
  await recordBuild(directory, uploading);
  let result;
  try {
    result = await upload();
    if (!uuid(result?.id) || result.app !== release.app || result.digest !== release.digest) throw new Error('Controller returned an inconsistent submission receipt; keep the local build');
  } catch (error) {
    await recordBuild(directory, { ...uploading, phase: 'uncertain' }).catch(() => {});
    throw error;
  }
  if (result.status !== 'pending') {
    await recordBuild(directory, { ...uploading, phase: 'uncertain' }).catch(() => {});
    return { result: { id: result.id, app: result.app, digest: result.digest, status: 'unconfirmed' }, receiptSaved: false };
  }
  try {
    await recordBuild(directory, { ...uploading, phase: 'submitted', submission: result.id });
    return { result, receiptSaved: true };
  } catch { return { result, receiptSaved: false }; }
}
