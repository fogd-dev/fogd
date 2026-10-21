import { recoveryScenarios } from './cron-probe/recovery/scenarios.mjs';
import { provenance, verifyFinalProvenance } from './cron-probe/recovery/provenance.mjs';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { prepareRecoveryFixture } from './cron-probe/recovery/fixture.mjs';
import { recoveryClient, restoredClient } from './cron-probe/recovery/client.mjs';

const [template, outputArg, image] = process.argv.slice(2);
assert.ok(template && outputArg && image, 'Usage: node scripts/cron-recovery.mjs TEMPLATE_COMPOSE NEW_PRIVATE_OUTPUT RUNTIME_IMAGE');
const output = resolve(outputArg), probes = [], evidence = {};
const identity = await provenance(image);
const { config, runner } = await prepareRecoveryFixture(resolve(template), output, image, identity.image);
const selected = JSON.parse(await readFile(join(output, 'environment.json'), 'utf8'));
const source = await recoveryClient(output, config, selected); probes.push(source); source.identity = identity;
const progress = async step => {
  console.log(step);
  await writeFile(join(output, 'progress.json'), JSON.stringify({ step, project: probes.at(-1).project }) + '\n', { mode: 0o600 });
};
await recoveryScenarios({ source, runner, output, probes, evidence, progress, restoreClient: restoredClient });
await verifyFinalProvenance(identity); evidence.provenance = identity;
await writeFile(join(output, 'recovery.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await progress('complete: all qualification projects stopped; volumes retained');
console.log('PASS: native full-installation cron/queue holds before controller startup, explicit recovery acknowledgment, separate resume, due timer, cleared pending retry and older-snapshot loss boundary');
