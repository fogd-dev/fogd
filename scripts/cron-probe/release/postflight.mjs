import assert from 'node:assert/strict';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';
import { volumeHelper } from '../../../packages/cli/src/recovery/volumes.mjs';

export async function retainedReleases(probe) {
  const label = `label=com.docker.compose.project=${probe.project}`;
  assert.equal((await projectContainers(probe.project)).length, 0);
  assert.equal((await execute('docker', ['network', 'ls', '-q', '--filter', label])).trim(), '');
  const volumes = (await execute('docker', ['volume', 'ls', '-q', '--filter', label])).trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(volumes, Object.values(probe.config.volumes).map(volume => volume.name).sort()); assert.equal(volumes.length, 7);
  const code = "import{readFile,readdir}from'node:fs/promises';import{artifactDigest}from'/app/packages/runtime/src/artifact.mjs';const s=JSON.parse(await readFile('/data/state.json','utf8'));const artifacts=await Promise.all(Object.values(s.deployments).map(async d=>({id:d.id,digest:d.digest,secretRevision:d.secretRevision,actual:await artifactDigest('/data/artifacts/'+d.id)})));console.log(JSON.stringify({app:s.apps.refresh,active:s.deployments[s.apps.refresh.active],artifacts,files:(await readdir('/data/qualification')).sort()}));";
  const state = JSON.parse(await volumeHelper(probe.runtimeProfile.image, probe.config.volumes.controller.name, ['/usr/local/bin/node', '--input-type=module', '-e', code]));
  return { state, volumes };
}
