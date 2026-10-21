// Full same-version recovery on a release binary with immutable qualification
// programs. Ordinary scheduled upload/restore admission remains closed.
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { sealedFixture } from './cron-probe/sealed/fixture.mjs';
import { sealedClient, sealedRestoredClient, verifyImmutableRunner } from './cron-probe/sealed/client.mjs';
import { provenance, verifyFinalProvenance } from './cron-probe/recovery/provenance.mjs';
import { sealedPostflight } from './cron-probe/sealed/postflight.mjs';
import { realBundleNegatives } from './cron-probe/sealed/negatives.mjs';
import { runQualification } from './cron-probe/recovery/trial.mjs';
import { bootstrap, retainAndDown } from './cron-probe/recovery/lifecycle.mjs';
import { data, native, operation, resumeScheduled } from './cron-probe/recovery/data.mjs';
import { recoveryScenarios } from './cron-probe/recovery/scenarios.mjs';

assert.ok(process.argv[2], 'Usage: node scripts/cron-sealed-recovery.mjs NEW_PRIVATE_OUTPUT [--smoke]');
const smoke = process.argv[3] === '--smoke';
assert.ok(process.argv.length === 3 || (process.argv.length === 4 && smoke));
const output = resolve(process.argv[2]);
const fixture = await sealedFixture(output);
const identity = await provenance(fixture.built.tag, { binary: fixture.profile.binarySha256,
  imagePattern: /^fogd-runtime:cron-sealed-fogd-m11c-cron-recovery-[a-f0-9]{6}$/ });
const source = await sealedClient(output, fixture.config, fixture.selected, fixture.profile, fixture.built.programs);
source.identity = identity;
const probes = [source], evidence = { profile: fixture.profile, build: fixture.built };
const progress = async step => {
  console.log(step);
  await writeFile(join(output, 'progress.json'), JSON.stringify({ step, project: probes.at(-1).project }) + '\n', { mode: 0o600 });
};
if (smoke) await sealedSmoke();
else await recoveryScenarios({ source, runner: fixture.runner, output, probes, evidence, progress,
  restoreClient: sealedRestoredClient, beforeRestore: realBundleNegatives, verifyInitialRunner: probe => verifyImmutableRunner(probe, fixture.artifact) });
if (!smoke) evidence.postflight = await sealedPostflight(probes, output);
await verifyFinalProvenance(identity);
evidence.provenance = identity;
evidence.runtimeObservations = probes.map(probe => ({ project: probe.project, ...probe.runtimeObservation, cronComparisons: probe.cronComparisons }));
evidence.artifactIntegrity = source.artifactIntegrity; evidence.restoreRefusals = source.restoreRefusals;
await writeFile(join(output, 'sealed-recovery.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
console.log(smoke ? 'PASS: sealed deploy, D1 queries and guarded/direct cron control smoke; owned project stopped and volumes retained' : 'PASS: sealed release runtime preserves due/retry/older snapshot holds, explicit recovery and queued survivor data; all qualification projects stopped and volumes retained');

async function sealedSmoke() {
  await runQualification(probes, output, async () => {
    await progress('smoke: staging both applications on the sealed layout');
    await bootstrap(source, fixture.runner); await verifyImmutableRunner(source, fixture.artifact);
    const before = await data(source), held = await native(source); assert.equal(held.paused, true);
    await operation(source, 'refresh', 'pause'); const resumed = await resumeScheduled(source);
    await operation(source, 'refresh', 'pause'); const paused = await native(source); assert.equal(paused.paused, true);
    evidence.smoke = { before, held, resumed, paused };
    await retainAndDown(source, null, 'smoke-complete');
  });
}
