import assert from 'node:assert/strict';
import { recoveryClient } from '../recovery/client.mjs';
import { guardCronDiagnostics } from '../sealed/diagnostics.mjs';
import { observeSealedRuntime } from '../sealed/observe.mjs';
import { checkedNativeDefaults, verifyNativeTimingEnvironment } from '../sealed/defaults.mjs';
import { retirementVariant } from './policy.mjs';
import { installRetirementTarget } from './install.mjs';

export async function sealedRetirementClient(directory, config, selected, authority, variant, programs, rootDirectory, rootProject) {
  const probe = await recoveryClient(directory, config, { ...selected, VOID_REMOTE: '0', WRANGLER_SEND_METRICS: 'false' });
  Object.assign(probe, { authority, variant, programs, rootDirectory, rootProject, runtimeProfile: retirementVariant(authority, variant), cronComparisons: [], runtimeObservations: [] });
  probe.prepareControllerData = () => import('../../../packages/cli/src/recovery/volumes.mjs').then(({ volumeHelper }) => volumeHelper(authority.image, config.volumes.controller.name, ['/usr/bin/chown', '-R', '0:0', '/data/qualification'], { readonly: false }));
  probe.verifyController = () => observe(probe, false);
  probe.verifyColdRuntime = () => observe(probe, true);
  probe.createTarget = async (path, next, nextVariant) => {
    const client = await sealedRetirementClient(path, next, probe.env, authority, nextVariant, programs, rootDirectory, rootProject);
    client.identity = probe.identity; return client;
  };
  guardCronDiagnostics(probe, ['refresh', 'scheduled-next']);
  return probe;
}
async function observe(probe, cold) {
  const observation = await observeSealedRuntime(probe, probe.programs, cold ? 'sealed-cold-runtime' : 'sealed-runtime', cold);
  const timing = await verifyNativeTimingEnvironment(probe);
  probe.runtimeObservations.push({ cold, observation, timing }); probe.runtimeObservation = observation;
}
export async function verifyRetirementRunner(probe) {
  assert.equal(probe.runtimeObservation?.sealedInventoryVerified, true);
  const code = `import{readdir}from'node:fs/promises';import{artifactDigest}from'/app/packages/runtime/src/artifact.mjs';console.log(JSON.stringify({files:await readdir('/var/lib/fogd/qualification'),artifacts:{refresh:await artifactDigest('/var/lib/fogd/qualification/artifact'),'scheduled-next':await artifactDigest('/var/lib/fogd/qualification/next-artifact')}}));`;
  const value = JSON.parse(await probe.compose(['exec', '-T', 'controller', '/usr/local/bin/node', '--input-type=module', '-e', code]));
  assert.deepEqual(value.artifacts, probe.authority.retirementArtifacts);
  const expected = ['artifact', 'next-artifact', 'command.json', 'result.json', 'preapproval.json', 'refresh-bootstrap.json'];
  if (probe.approvals?.['scheduled-next']) expected.push('scheduled-next-bootstrap.json');
  assert.deepEqual(value.files.sort(), expected.sort(), 'Controller data must contain exactly the expected artifacts and records');
  const defaults = await checkedNativeDefaults(); assert.equal(defaults.wakerTickMs, 60000);
}

export function sealedRetirementInstall(source, request) { return installRetirementTarget(source, request, source.createTarget); }
