// Private release-runtime activation qualification. Ordinary cron admission
// stays closed; case and artifact authority comes from the immutable image.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sealedFixture } from './cron-probe/sealed/fixture.mjs';
import { observeSealedRuntime } from './cron-probe/sealed/observe.mjs';
import { activationClient } from './cron-probe/activation/client.mjs';
import { runInterruptionScenarios } from './cron-probe/activation/scenarios.mjs';
import { activationPostflight } from './cron-probe/activation/postflight.mjs';
import { requireEmptyFleet } from './queue-probe/context.mjs';
import { volumeHelper } from '../packages/cli/src/recovery/volumes.mjs';
import { provenance, verifyFinalProvenance } from './cron-probe/recovery/provenance.mjs';
import { runQualification } from './cron-probe/recovery/trial.mjs';

assert.equal(process.argv.length, 3, 'Usage: node scripts/cron-sealed-activation.mjs NEW_PRIVATE_OUTPUT');
const output = resolve(process.argv[2]);
const fixture = await sealedFixture(output, { kind: 'activation' });
const identity = await provenance(fixture.built.tag, { binary: fixture.profile.binarySha256,
  imagePattern: /^fogd-runtime:cron-sealed-fogd-m11c-cron-activation-[a-f0-9]{6}$/ });
for (const [program, source] of Object.entries(fixture.built.sourcePrograms)) assert.equal(fixture.built.programs[program], identity.probe[source], 'Image qualification program must match its source fingerprint');
const bytes = await readFile(join(output, 'image/qualification/runtime-policy.json'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.built.programs['/app/qualification/runtime-policy.json']);
const policy = JSON.parse(bytes), probe = activationClient(fixture);
const progress = async step => {
  console.log(step);
  await writeFile(join(output, 'progress.json'), JSON.stringify({ project: probe.project, step }) + '\n', { mode: 0o600 });
};
let scenarios, observed;
await runQualification([probe], output, async () => {
  await progress('creating fresh sealed activation host');
  await probe.compose(['create', '--pull', 'never']);
  await probe.compose(['cp', `${fixture.runner}/.`, 'controller:/var/lib/fogd/qualification']);
  await volumeHelper(fixture.profile.image, fixture.config.volumes.controller.name,
    ['/usr/bin/chown', '-R', '0:0', '/data/qualification'], { readonly: false });
  await probe.compose(['up', '-d', '--no-build', '--pull', 'never']);
  observed = await observeSealedRuntime(probe, fixture.built.programs);
  await requireEmptyFleet(probe);
  scenarios = await runInterruptionScenarios({ probe, stage: fixture.prepared.stage, policy, progress });
});
const postflight = await activationPostflight(probe, policy, scenarios);
await verifyFinalProvenance(identity);
await probe.save('sealed-activation', { scope: 'Selected activation and controller SIGKILL boundaries on the sealed guarded release runtime. Direct Controller construction with internal gateway lookups; no startController, external admin API or TLS qualification. Native default handler budget; legacy 20-second override is absent. Final cleanup pause bypasses the dispatch journal. No ordinary cron admission or transfer of other receipts.',
  profile: fixture.profile, build: fixture.built, policy: policy.interruption,
  provenance: identity, runtimeObservation: observed, cronComparisons: probe.cronComparisons, scenarios, shutdown: probe.shutdown, postflight });
console.log('PASS: guarded release-runtime activation survives publication/resume/durable-release SIGKILL and paused update; owned containers/networks removed and all volumes retained');
