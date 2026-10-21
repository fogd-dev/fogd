import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { stackRoot } from '../../../packages/cli/src/local.mjs';
import { volumeHelper } from '../../../packages/cli/src/recovery/volumes.mjs';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';
import { sealedFixture } from '../sealed/fixture.mjs';
import { observeSealedRuntime } from '../sealed/observe.mjs';
import { checkedNativeDefaults, verifyNativeTimingEnvironment } from '../sealed/defaults.mjs';
import replacementContract from '../replacement/contract.mjs';
import failureContract from '../faults/contract.mjs';
import { startReleaseSession } from './session.mjs';
import { qualificationInputs, provenance, verifyFinalProvenance } from '../recovery/provenance.mjs';
import { runQualification } from '../recovery/trial.mjs';
import { requireEmptyFleet } from '../../queue-probe/context.mjs';

export async function qualifyReleases({ kind, directory, failureCheck = false, client, scenarios, rejected, postflight, scope, message }) {
  assert.ok(['replacement', 'failures'].includes(kind));
  if (failureCheck) assert.equal(kind, 'replacement');
  const output = resolve(directory), local = relative(join(stackRoot, '.fogd'), output);
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local), 'Release evidence must be inside ignored .fogd storage');
  const inputs = await qualificationInputs(), defaults = await checkedNativeDefaults();
  const fixture = await sealedFixture(output, { kind });
  const identity = await provenance(fixture.built.tag, { binary: fixture.profile.binarySha256, imagePattern: new RegExp(`^fogd-runtime:cron-sealed-fogd-m11c-cron-${kind}-[a-f0-9]{6}$`) });
  assert.deepEqual({ platform: identity.platform, probe: identity.probe }, inputs, 'Source changed during offline build or image construction');
  for (const [program, source] of Object.entries(fixture.built.sourcePrograms)) assert.equal(fixture.built.programs[program], identity.probe[source]);
  const policyBytes = await readFile(join(output, 'image/qualification/runtime-policy.json'));
  assert.equal(createHash('sha256').update(policyBytes).digest('hex'), fixture.built.programs['/app/qualification/runtime-policy.json']);
  const policy = JSON.parse(policyBytes), probe = client(fixture);
  const progress = async step => { console.log(step); await writeFile(join(output, 'progress.json'), JSON.stringify({ project: probe.project, step })+'\n', { mode: 0o600 }); };
  const restartObservations = [];
  async function observeRestart(name) {
    assert.ok(['owner-rejoin-runtime', 'downtime-runtime'].includes(name)); probe.recordAccess?.('runtime-observation');
    const observed = await observeSealedRuntime(probe, fixture.built.programs, name), timingOverrides = await verifyNativeTimingEnvironment(probe);
    restartObservations.push({ name, observed, timingOverrides }); return observed;
  }
  let evidence, observed, timingOverrides;
  await fresh(probe);
  await runQualification([probe], output, async () => {
    await progress(`creating fresh sealed ${kind} fixture after offline builds`);
    await probe.compose(['create', '--pull', 'never']);
    await probe.compose(['cp', `${fixture.runner}/.`, 'controller:/var/lib/fogd/qualification']);
    await volumeHelper(fixture.profile.image, fixture.config.volumes.controller.name, ['/usr/bin/chown', '-R', '0:0', '/data/qualification'], { readonly: false });
    await probe.compose(['up', '-d', '--no-build', '--pull', 'never']);
    observed = await observeSealedRuntime(probe, fixture.built.programs);
    timingOverrides = await verifyNativeTimingEnvironment(probe); await requireEmptyFleet(probe);
    const session = await startReleaseSession(probe, policy, (kind === 'replacement' ? replacementContract : failureContract).minutes);
    evidence = failureCheck ? await rejected(probe, session) : await scenarios({ probe, session, progress, defaults, observeRestart, initialObservation: observed });
  });
  try {
    const retained = await postflight(probe, policy, evidence, failureCheck); await verifyFinalProvenance(identity);
    await probe.save(`sealed-${kind}${failureCheck ? '-failure' : ''}`, { scope: failureCheck
      ? 'Deliberately rejected publication observation must time out without publishing final, preserve the prior approved version and persist a journal pause. Expected broker exit1; no full positive replacement claim.' : scope,
      profile: fixture.profile, build: fixture.built, policy: policy.releases, defaults, timingOverrides, provenance: identity, runtimeObservation: observed, restartObservations,
      offlineBuilds: Object.fromEntries(Object.entries(fixture.prepared.releases).map(([name, release]) => [name, release.verification])),
      evidence, cronComparisons: probe.cronComparisons, shutdown: probe.shutdown, postflight: retained });
  } catch (error) { await probe.save('finalization-failure', { message: error.message, stack: error.stack }); throw error; }
  console.log(failureCheck ? 'PASS: rejected publication gate expired without new publication; prior approval and journal pause retained, owned project stopped and volumes retained' : message);
}
async function fresh(probe) {
  assert.equal((await projectContainers(probe.project)).length, 0);
  for (const kind of ['volume', 'network']) assert.equal((await execute('docker', [kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${probe.project}`])).trim(), '');
  for (const volume of Object.values(probe.config.volumes)) await assert.rejects(execute('docker', ['volume', 'inspect', volume.name]));
  for (const network of Object.values(probe.config.networks)) await assert.rejects(execute('docker', ['network', 'inspect', network.name]));
}
