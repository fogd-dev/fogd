import assert from 'node:assert/strict';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { volumeHelper } from '../../../packages/cli/src/recovery/volumes.mjs';
import { projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';
import { retirementVariant, assertRetirementHistory } from './policy.mjs';

export async function retirementPostflight(probes, dual) {
  assert.equal(probes.length, dual ? 4 : 7);
  const targets = [];
  for (const probe of probes) {
    assert.equal(probe.closed, true); assert.equal((await projectContainers(probe.project)).length, 0);
    const label = `label=com.docker.compose.project=${probe.project}`;
    assert.equal((await execute('docker', ['network', 'ls', '-q', '--filter', label])).trim(), '');
    const volumes = (await execute('docker', ['volume', 'ls', '-q', '--filter', label])).trim().split('\n').filter(Boolean).sort();
    assert.deepEqual(volumes, Object.values(probe.config.volumes).map(value => value.name).sort()); assert.equal(volumes.length, 7);
    const state = JSON.parse(await volumeHelper(probe.identity.image, probe.config.volumes.controller.name, ['cat', '/data/state.json']));
    const history = assertRetirementHistory(probe.authority, probe.variant, state);
    const expected = retirementVariant(probe.authority, probe.variant);
    for (const fleet of expected.fleets) for (const node of fleet.nodes) {
      assert.equal(probe.config.services[node.host].environment.CELLD_NODE, node.id);
      assert.equal(probe.config.services[node.host].environment.CELLD_BUCKET, `s3://${expected.bucket}/${fleet.prefix}`);
    }
    assert.deepEqual(probe.config.services.controller.command, expected.controllerArgs);
    const cold = probe.runtimeObservations.filter(item => item.cold);
    assert.equal(cold.length, probe === probes[0] ? 0 : 1);
    assert.equal(probe.runtimeObservations.filter(item => !item.cold).length, 1);
    const artifacts = [];
    for (const name of ['refresh', 'scheduled-next']) {
      for (const active of Object.values(state.deployments).filter(row => row.app === name)) {
        const actual = (await volumeHelper(probe.identity.image, probe.config.volumes.controller.name, ['/usr/local/bin/node', '--input-type=module', '-e', `import{artifactDigest}from'/app/packages/runtime/src/artifact.mjs';console.log(await artifactDigest('/data/artifacts/'+${JSON.stringify(active.id)}));`])).trim();
        assert.equal(actual, active.digest); assert.equal(actual, probe.authority.retirementArtifacts[name]); artifacts.push({ app: name, digest: actual });
      }
    }
    for (const comparison of probe.cronComparisons.filter(row => row.held)) assert.deepEqual(comparison.guarded, comparison.direct);
    targets.push({ project: probe.project, variant: probe.variant, history, artifacts, retainedVolumes: volumes });
  }
  return { targets, retainedVolumes: targets.reduce((total, row) => total + row.retainedVolumes.length, 0), noOwnedContainersOrNetworks: true };
}
