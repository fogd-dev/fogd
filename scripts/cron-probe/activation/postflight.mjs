import assert from 'node:assert/strict';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';
import { volumeHelper } from '../../../packages/cli/src/recovery/volumes.mjs';

export async function activationPostflight(probe, policy, scenarios) {
  const filter = `label=com.docker.compose.project=${probe.project}`;
  assert.equal((await projectContainers(probe.project)).length, 0);
  assert.equal((await execute('docker', ['network', 'ls', '-q', '--filter', filter])).trim(), '');
  const volumes = (await execute('docker', ['volume', 'ls', '-q', '--filter', filter])).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(volumes, Object.values(probe.config.volumes).map(volume => volume.name).sort());
  assert.equal(volumes.length, 7);
  assert.deepEqual(scenarios.cases.map(value => value.name), ['first-publication', 'first-resume', 'update-durable-release', 'paused-update-publication']);
  assert.ok(scenarios.cases.every(value => value.exitCode === 137));
  const state = JSON.parse(await volumeHelper(probe.runtimeProfile.image, probe.config.volumes.controller.name, ['cat', '/data/state.json']));
  const final = scenarios.cases.at(-1).explicitRetry.state.target;
  const app = state.apps.refresh, active = state.deployments[app.active];
  assert.deepEqual({ id: active.id, digest: active.digest, secretRevision: active.secretRevision }, { id: final.id, digest: final.digest, secretRevision: final.secretRevision });
  assert.equal(active.status, 'active'); assert.equal(app.dispatch.desired, 'paused');
  assert.equal(app.dispatch.hold, null); assert.equal(app.dispatch.operation, null);
  const code = "import{readFile,readdir}from'node:fs/promises';import{artifactDigest}from'/app/packages/runtime/src/artifact.mjs';const s=JSON.parse(await readFile('/data/state.json','utf8'));const deployments=await Promise.all(Object.values(s.deployments).map(async d=>({id:d.id,digest:d.digest,actual:await artifactDigest('/data/artifacts/'+d.id)})));console.log(JSON.stringify({deployments,files:(await readdir('/data/qualification')).sort()}));";
  const integrity = JSON.parse(await volumeHelper(probe.runtimeProfile.image, probe.config.volumes.controller.name, ['/usr/local/bin/node', '--input-type=module', '-e', code]));
  assert.deepEqual(integrity.files, ['artifacts', 'cases', 'target.json']);
  assert.equal(integrity.deployments.length, 3);
  assert.deepEqual(integrity.deployments.map(value => value.digest).sort(), Object.values(policy.interruption.artifacts).sort());
  for (const value of integrity.deployments) assert.equal(value.actual, value.digest);
  assert.equal(probe.cronComparisons.at(-1).operation, 'pause');
  assert.equal(probe.cronComparisons.at(-1).guarded.paused, true);
  return { retainedVolumes: volumes, noOwnedContainersOrNetworks: true, state: { active: active.id, digest: active.digest,
    secretRevision: active.secretRevision, desired: app.dispatch.desired, hold: app.dispatch.hold }, integrity };
}
