import assert from 'node:assert/strict';
import { join } from 'node:path';
import { volumeHelper } from '../../../packages/cli/src/recovery/volumes.mjs';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';
import { compareSourceVolumes } from '../recovery/preservation.mjs';

export async function sealedPostflight(probes, output) {
  const negativeRestores = probes[0].restoreRefusals;
  assert.deepEqual(negativeRestores?.map(result => result.case), ['ordinary-cli', 'wrong-native-digest']);
  assert.ok(negativeRestores.every(result => result.refused && result.noTargetResources));
  const sources = {};
  for (const [index, name] of [[0, 'a'], [1, 'b']]) sources[name] = await compareSourceVolumes(probes[index], join(output, `snapshot-${name}`));
  const targets = [];
  for (const probe of probes) {
    const label = `label=com.docker.compose.project=${probe.project}`;
    assert.equal((await projectContainers(probe.project)).length, 0);
    assert.equal((await execute('docker', ['network', 'ls', '-q', '--filter', label])).trim(), '');
    const names = (await execute('docker', ['volume', 'ls', '-q', '--filter', label])).trim().split('\n').filter(Boolean).sort();
    assert.deepEqual(names, Object.values(probe.config.volumes).map(volume => volume.name).sort());
    for (const fleet of probe.runtimeProfile.fleets) for (const node of fleet.nodes) assert.equal(probe.config.services[node.host].environment.CELLD_NODE, node.id);
    if (probe === probes[0]) continue;
    const held = probe.cronComparisons.filter(result => result.held);
    assert.ok(held.length >= 1, 'Every restored target requires a guarded/direct held observation');
    for (const result of held) assert.deepEqual(result.guarded, result.direct);
    const state = JSON.parse(await volumeHelper(probe.runtimeProfile.image, probe.config.volumes.controller.name, ['cat', '/data/state.json']));
    const apps = {};
    for (const name of ['refresh', 'imports']) {
      const app = state.apps[name], active = state.deployments[app.active], expected = probe.approvals[name];
      assert.deepEqual({ deployment: active.id, digest: active.digest, secretRevision: active.secretRevision ?? null }, {
        deployment: expected.deployment, digest: expected.digest, secretRevision: expected.secretRevision,
      });
      const field = name === 'refresh' ? 'cronRecovery' : 'queueRecovery';
      assert.equal(app[field].status, 'acknowledged');
      apps[name] = { deployment: active.id, digest: active.digest, secretRevision: active.secretRevision ?? null,
        recovery: { id: app[field].id, status: app[field].status } };
    }
    targets.push({ project: probe.project, apps, retainedVolumes: names });
  }
  assert.equal(probes.length, 4); assert.equal(targets.length, 3);
  return { sources, targets, retainedVolumes: probes.reduce((count, probe) => count + Object.keys(probe.config.volumes).length, 0),
    sourceDownEnforcedSeparatelyFromIdentity: true, negativeRestores };
}
