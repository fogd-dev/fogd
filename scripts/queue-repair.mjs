import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cp, mkdir } from 'node:fs/promises';
import { context, requireEmptyFleet, upload } from './queue-probe/context.mjs';
import { stageNative } from './queue-probe/native.mjs';

const [slot, output] = process.argv.slice(2);
const probe = await context(slot, output, { queueName: 'imports' }); await requireEmptyFleet(probe);
const stage = await stageNative(join(probe.output, 'app'));
const project = await upload(probe, stage.output, 'repair-app');
const runner = join(probe.output, 'runner'); await mkdir(runner);
for (const file of ['repair.mjs', 'controller-artifact.mjs']) await cp(new URL(`./queue-probe/${file}`, import.meta.url), join(runner, file));
const remote = await upload(probe, runner, 'repair-runner');
const result = JSON.parse((await probe.compose(['exec', '-T', 'controller', 'node', `${remote}/repair.mjs`, project, slot])).trim());
assert.equal(result.firstInsertRolledBack, true); assert.equal(result.corrected.status, 'active'); assert.equal(result.queue.paused, true);
await probe.save('repair', { ...result, controllerImage: probe.config.services.controller.image });
console.log('PASS: real D1 rolls back a failing multi-statement file, preserves earlier migration hashes, and activates the corrected artifact through explicit HTTP replacement approval');
