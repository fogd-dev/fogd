import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { recoveryClient } from '../recovery/client.mjs';
import { observeSealedRuntime } from './observe.mjs';
import { verifyBundle } from '../../../packages/cli/src/recovery/bundle.mjs';
import { restoreInstallation } from '../../../packages/cli/src/recovery/restore.mjs';
import { volumeHelper } from '../../../packages/cli/src/recovery/volumes.mjs';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { composeArgs, projectContainers, stopped } from '../../../packages/cli/src/recovery/docker.mjs';
import { artifactDigest } from '../../../packages/runtime/src/artifact.mjs';

export async function sealedClient(directory, config, selected, profile, programs) {
  const probe = await recoveryClient(directory, config, selected);
  probe.runtimeProfile = structuredClone(profile); probe.programs = programs; probe.cronComparisons = [];
  probe.verifyController = async () => { probe.runtimeObservation = await observeSealedRuntime(probe, programs); };
  probe.prepareControllerData = () => volumeHelper(profile.image, config.volumes.controller.name,
    ['/usr/bin/chown', '-R', '0:0', '/data/qualification'], { readonly: false });
  const raw = probe.cli;
  probe.cli = async (args, slot = probe.slot) => {
    if (args[0] !== 'cron') return raw(args, slot);
    assert.deepEqual(args, ['cron', 'info', 'refresh', '--json'], 'Only guarded cron status is a diagnostic command');
    const code = `import{guardedBackend}from'/app/qualification/backend.mjs';const backend=await guardedBackend();try{console.log(JSON.stringify(await backend.crons.status(${JSON.stringify(slot)},'refresh')))}finally{backend.s3.destroy()}`;
    const guarded = await probe.compose(probe.daemon
      ? ['exec', '-T', 'controller', '/usr/local/bin/node', '--input-type=module', '-e', code]
      : ['run', '--rm', '--no-deps', '--entrypoint', '/usr/local/bin/node', 'controller', '--input-type=module', '-e', code]);
    const native = JSON.parse(await raw(args, slot)), checked = JSON.parse(guarded);
    if (checked.paused) assert.deepEqual(native, checked, 'Guarded and direct held status differ');
    probe.cronComparisons.push({ guarded: checked, direct: native, held: checked.paused });
    return guarded;
  };
  return probe;
}
export async function sealedRestoredClient(source, bundle, project, directory) {
  const verified = await verifyBundle(bundle);
  await stopped(verified.manifest.sourceProject, Object.values(verified.config.volumes).map(volume => volume.name));
  try {
    await restoreInstallation({ ...verified, dir: bundle }, project, directory, null, source.runtimeProfile);
    const config = JSON.parse(await readFile(join(directory, 'compose.json'), 'utf8'));
    const target = await sealedClient(directory, config, source.env, source.runtimeProfile, source.programs);
    target.identity = source.identity;
    for (const name of Object.keys(source.config.volumes)) assert.notEqual(config.volumes[name].name, source.config.volumes[name].name);
    return target;
  } catch (error) {
    try { await cleanupTarget(project, directory); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Sealed restore and target cleanup failed', { cause: error }); }
    throw error;
  }
}
async function cleanupTarget(project, directory) {
  for (const name of ['compose.json', 'compose.pending.json']) {
    try { await readFile(join(directory, name)); }
    catch (missing) { if (missing.code === 'ENOENT') continue; throw missing; }
    await execute('docker', [...composeArgs(join(directory, name), project), 'down']); break;
  }
  assert.equal((await projectContainers(project)).length, 0, 'Failed target cleanup must retain volumes and remove only owned containers');
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
