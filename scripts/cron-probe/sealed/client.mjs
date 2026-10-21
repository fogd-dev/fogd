import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { recoveryClient } from '../recovery/client.mjs';
import { requireFreshTarget, cleanupNewTarget } from '../recovery/target.mjs';
import { guardCronDiagnostics } from './diagnostics.mjs';
import { observeSealedRuntime } from './observe.mjs';
import { verifyBundle } from '../../../packages/cli/src/recovery/bundle.mjs';
import { restoreInstallation } from '../../../packages/cli/src/recovery/restore.mjs';
import { volumeHelper } from '../../../packages/cli/src/recovery/volumes.mjs';
import { stopped } from '../../../packages/cli/src/recovery/docker.mjs';
import { artifactDigest } from '../../../packages/runtime/src/artifact.mjs';

export async function sealedClient(directory, config, selected, profile, programs) {
  const probe = await recoveryClient(directory, config, selected);
  probe.runtimeProfile = structuredClone(profile); probe.programs = programs; probe.cronComparisons = [];
  probe.verifyController = async () => { probe.runtimeObservation = await observeSealedRuntime(probe, programs); };
  probe.prepareControllerData = () => volumeHelper(profile.image, config.volumes.controller.name,
    ['/usr/bin/chown', '-R', '0:0', '/data/qualification'], { readonly: false });
  guardCronDiagnostics(probe);
  return probe;
}
export async function sealedRestoredClient(source, bundle, project, directory) {
  const verified = await verifyBundle(bundle);
  await stopped(verified.manifest.sourceProject, Object.values(verified.config.volumes).map(volume => volume.name));
  await requireFreshTarget(project, directory, verified.config);
  try {
    await restoreInstallation({ ...verified, dir: bundle }, project, directory, null, source.runtimeProfile);
    const config = JSON.parse(await readFile(join(directory, 'compose.json'), 'utf8'));
    const target = await sealedClient(directory, config, source.env, source.runtimeProfile, source.programs);
    target.identity = source.identity;
    for (const name of Object.keys(source.config.volumes)) assert.notEqual(config.volumes[name].name, source.config.volumes[name].name);
    return target;
  } catch (error) {
    try { await cleanupNewTarget(project, directory, verified.config); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Sealed restore and target cleanup failed', { cause: error }); }
    throw error;
  }
}
export async function verifyImmutableRunner(probe, expectedArtifact) {
  assert.ok(probe.runtimeObservation?.sealedInventoryVerified);
  const files = JSON.parse(await probe.compose(['exec', '-T', 'controller', '/usr/local/bin/node', '--input-type=module', '-e',
    "import{readdir}from'node:fs/promises';console.log(JSON.stringify(await readdir('/var/lib/fogd/qualification')));"]));
  assert.deepEqual(files.sort(), ['artifact', 'command.json', 'result.json']);
  const active = probe.approvals.refresh;
  const digest = (await probe.compose(['exec', '-T', 'controller', '/usr/local/bin/node', '--input-type=module', '-e',
    `import{artifactDigest}from'/app/packages/runtime/src/artifact.mjs';console.log(await artifactDigest('/var/lib/fogd/artifacts/${active.deployment}'));`])).trim();
  assert.equal(digest, expectedArtifact); assert.equal(digest, active.digest);
  const copy = join(probe.file, '..', 'approved-artifact'); await mkdir(copy);
  await probe.compose(['cp', `controller:/var/lib/fogd/artifacts/${active.deployment}/.`, copy]);
  const hostCopyDigest = await artifactDigest(copy);
  assert.equal(hostCopyDigest, expectedArtifact, 'Copied approved artifact differs from the image-pinned fixture');
  probe.artifactIntegrity = { deployment: active.deployment, digest, hostBuildDigest: expectedArtifact, hostCopyDigest };
}
