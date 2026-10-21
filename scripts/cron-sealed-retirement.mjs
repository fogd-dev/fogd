import assert from 'node:assert/strict';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { sealedFixture } from './cron-probe/sealed/fixture.mjs';
import { sealedRetirementClient, sealedRetirementInstall, verifyRetirementRunner } from './cron-probe/retirement/sealed-client.mjs';
import { retirementScenarios } from './cron-probe/retirement/scenarios.mjs';
import { dualRetirementScenarios } from './cron-probe/retirement/dual-scenarios.mjs';
import { retirement } from './cron-probe/retirement/transitions.mjs';
import { ordinaryRefusal, wrongVariantRefusal, retirementCleanupCheck } from './cron-probe/retirement/negatives.mjs';
import { targetOwnershipCheck } from './cron-probe/retirement/ownership-check.mjs';
import { retirementPostflight } from './cron-probe/retirement/postflight.mjs';
import { requireFreshResources } from './cron-probe/recovery/target.mjs';
import { qualificationInputs, provenance, verifyFinalProvenance } from './cron-probe/recovery/provenance.mjs';
import { checkedNativeDefaults } from './cron-probe/sealed/defaults.mjs';
import { stackRoot } from '../packages/cli/src/local.mjs';

const dual = process.argv[3] === '--dual';
assert.ok(process.argv.length === 3 || (process.argv.length === 4 && dual), 'Usage: node scripts/cron-sealed-retirement.mjs NEW_PRIVATE_OUTPUT [--dual]');
const output = resolve(process.argv[2]), local = relative(join(stackRoot, '.fogd'), output);
assert.ok(local && !local.startsWith('..') && !isAbsolute(local));
const inputs = await qualificationInputs(), defaults = await checkedNativeDefaults();
const kind = dual ? 'retirement-dual' : 'retirement', fixture = await sealedFixture(output, { kind });
const identity = await provenance(fixture.built.tag, { binary: fixture.profile.binarySha256, imagePattern: /^fogd-runtime:cron-sealed-fogd-m11c-cron-retirement(?:-dual)?-[a-f0-9]{6}$/ });
assert.deepEqual({ platform: identity.platform, probe: identity.probe }, inputs);
const authority = { ...fixture.profile, ...fixture.prepared.policy };
const source = await sealedRetirementClient(output, fixture.config, fixture.selected, authority, 'initial', fixture.built.programs, output, fixture.config.name);
source.identity = identity;
await requireFreshResources(source.project, source.config);
const ownership = await targetOwnershipCheck(source);
const probes = [source], evidence = { retirements: [] }, refusals = [];
const progress = async step => { console.log(step); await writeFile(join(output, 'progress.json'), JSON.stringify({ step, project: probes.at(-1).project })+'\n', { mode: 0o600 }); };
const retireClient = async (probe, point, app, directory, suffix) => {
  if (probe === source) {
    refusals.push(await ordinaryRefusal(probe, point, 'restore', 'restore'));
    refusals.push(await ordinaryRefusal(probe, point, 'retire', 'retire'));
    refusals.push(await wrongVariantRefusal(probe, point));
  }
  return retirement(probe, point, app, directory, suffix, sealedRetirementInstall);
};
const restoreClient = async (probe, bundle, project, directory) => {
  if (!Object.keys(probe.backgroundApps).length) refusals.push(await ordinaryRefusal(probe, { directory: bundle }, 'restore', 'zero'));
  return sealedRetirementInstall(probe, { kind: 'restore', bundle, project, directory });
};
const result = await (dual ? dualRetirementScenarios : retirementScenarios)({ source, runner: fixture.runner, output, identity, probes, evidence, progress,
  verifyRunner: verifyRetirementRunner, retireClient, restoreClient, expectedControllerCommand: probe => probe.runtimeProfile.controllerArgs });
const initialBundle = dual ? result.points[0].point.directory : result.snapshots[0].directory;
const cleanup = await retirementCleanupCheck(source, initialBundle);
const postflight = await retirementPostflight(probes, dual); await verifyFinalProvenance(identity);
await source.save(`sealed-${kind}`, { scope: 'Private guarded signed-runtime retirement. Ordinary scheduled upload, restore and retirement admission remain closed. Zero-live restore uses independent host policy before ordinary controller startup. No global lifecycle fence, arbitrary drain, CPU-exhaustion or hosted Cloudflare qualification.',
  profile: fixture.profile, policy: fixture.prepared.policy, build: fixture.built, offline: fixture.prepared.offline, defaults, provenance: identity,
  evidence, refusals, cleanup, ownership, postflight, observations: probes.map(probe => ({ project: probe.project, variant: probe.variant, runtime: probe.runtimeObservations, cronComparisons: probe.cronComparisons })) });
console.log('PASS: signed-runtime retirement preserves full survivor/reuse/source/held-restore oracles; ordinary admission closed, owned projects stopped and volumes retained');
