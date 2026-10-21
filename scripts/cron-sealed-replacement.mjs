import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { stackRoot } from '../packages/cli/src/local.mjs';
import { volumeHelper } from '../packages/cli/src/recovery/volumes.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { projectContainers } from '../packages/cli/src/recovery/docker.mjs';
import { sealedFixture } from './cron-probe/sealed/fixture.mjs';
import { observeSealedRuntime } from './cron-probe/sealed/observe.mjs';
import { replacementClient } from './cron-probe/replacement/client.mjs';
import { startReplacementSession } from './cron-probe/replacement/session.mjs';
import { replacementScenarios } from './cron-probe/replacement/scenarios.mjs';
import { replacementPostflight } from './cron-probe/replacement/postflight.mjs';
import { checkedNativeDefaults } from './cron-probe/replacement/defaults.mjs';
import { rejectedPublicationGate } from './cron-probe/replacement/rejected-gate.mjs';
import { qualificationInputs, provenance, verifyFinalProvenance } from './cron-probe/recovery/provenance.mjs';
import { runQualification } from './cron-probe/recovery/trial.mjs';
import { requireEmptyFleet } from './queue-probe/context.mjs';

const failureCheck = process.argv[3] === '--failure-check';
assert.ok(process.argv.length === 3 || (process.argv.length === 4 && failureCheck), 'Usage: node scripts/cron-sealed-replacement.mjs NEW_PRIVATE_OUTPUT [--failure-check]');
const output = resolve(process.argv[2]), local = relative(join(stackRoot, '.fogd'), output);
assert.ok(local && !local.startsWith('..') && !isAbsolute(local), 'Replacement evidence must be inside ignored .fogd storage');
const inputs = await qualificationInputs(), defaults = await checkedNativeDefaults();
const fixture = await sealedFixture(output, { kind: 'replacement' });
const identity = await provenance(fixture.built.tag, { binary: fixture.profile.binarySha256, imagePattern: /^fogd-runtime:cron-sealed-fogd-m11c-cron-replacement-[a-f0-9]{6}$/ });
assert.deepEqual({ platform: identity.platform, probe: identity.probe }, inputs, 'Source changed during offline build or image construction');
for (const [program, source] of Object.entries(fixture.built.sourcePrograms)) assert.equal(fixture.built.programs[program], identity.probe[source]);
const policyBytes = await readFile(join(output, 'image/qualification/runtime-policy.json'));
assert.equal(createHash('sha256').update(policyBytes).digest('hex'), fixture.built.programs['/app/qualification/runtime-policy.json']);
const policy = JSON.parse(policyBytes), probe = replacementClient(fixture);
const progress = async step => { console.log(step); await writeFile(join(output, 'progress.json'), JSON.stringify({ project: probe.project, step })+'\n', { mode: 0o600 }); };
let evidence, observed, session, timingOverrides;
await fresh();
await runQualification([probe], output, async () => {
  await progress('creating fresh sealed replacement fixture after offline builds');
  await probe.compose(['create', '--pull', 'never']);
  await probe.compose(['cp', `${fixture.runner}/.`, 'controller:/var/lib/fogd/qualification']);
  await volumeHelper(fixture.profile.image, fixture.config.volumes.controller.name, ['/usr/bin/chown', '-R', '0:0', '/data/qualification'], { readonly: false });
  await probe.compose(['up', '-d', '--no-build', '--pull', 'never']);
  observed = await observeSealedRuntime(probe, fixture.built.programs);
  timingOverrides = await noTimingOverrides(); await requireEmptyFleet(probe);
  session = await startReplacementSession(probe, policy);
  evidence = failureCheck ? await rejectedPublicationGate(probe, session) : await replacementScenarios({ probe, session, defaults, progress });
});
try {
  const postflight = await replacementPostflight(probe, policy, evidence, failureCheck); await verifyFinalProvenance(identity);
  await probe.save(failureCheck ? 'sealed-replacement-failure' : 'sealed-replacement', { scope: failureCheck
    ? 'Deliberately rejected publication observation must time out without publishing final, preserve the prior approved version and persist a journal pause. Expected broker exit1; no full positive replacement claim.'
    : 'Private guarded release-runtime replacement on native defaults, with exact artifacts produced by offline ordinary Void/fogd builds. No normal cron admission or generic drain/replay guarantee.',
    profile: fixture.profile, build: fixture.built, policy: policy.replacement, defaults, timingOverrides, provenance: identity, runtimeObservation: observed,
    offlineBuilds: Object.fromEntries(Object.entries(fixture.prepared.releases).map(([name, release]) => [name, release.verification])),
    evidence, cronComparisons: probe.cronComparisons, shutdown: probe.shutdown, postflight });
} catch (error) { await probe.save('finalization-failure', { message: error.message, stack: error.stack }); throw error; }
console.log(failureCheck ? 'PASS: rejected publication gate timed out without new publication; prior approval and journal pause retained, owned project stopped and volumes retained'
  : 'PASS: guarded replacement preserves migration overlap, measured unfinished work and retry identity on native defaults; offline-built artifacts checked, owned project stopped and volumes retained');
async function fresh() {
  assert.equal((await projectContainers(probe.project)).length, 0);
  for (const kind of ['volume', 'network']) assert.equal((await execute('docker', [kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${probe.project}`])).trim(), '');
  for (const volume of Object.values(probe.config.volumes)) await assert.rejects(execute('docker', ['volume', 'inspect', volume.name]));
  for (const network of Object.values(probe.config.networks)) await assert.rejects(execute('docker', ['network', 'inspect', network.name]));
}
async function noTimingOverrides() {
  const rows = await projectContainers(probe.project);
  for (const slot of probe.slots) for (const host of slot.nodes) {
    const service = probe.config.services[host], actual = rows.find(row => row.Config.Labels['com.docker.compose.service'] === host);
    assert.ok(actual);
    for (const key of ['CELLD_HANDLER_BUDGET_S', 'CELLD_OPERATION_DEADLINE_MS']) {
      assert.equal(service.environment[key], undefined); assert.ok(!actual.Config.Env.some(value => value.startsWith(key+'=')));
    }
  }
  return { hosts: probe.slots.flatMap(slot => slot.nodes), composeAndRunningEnvironmentChecked: true,
    absent: ['CELLD_HANDLER_BUDGET_S', 'CELLD_OPERATION_DEADLINE_MS'] };
}
