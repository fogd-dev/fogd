import assert from 'node:assert/strict';
import { queueRuntime } from './queue-probe/runtime.mjs';
import { context } from './queue-probe/context.mjs';
import { expect } from './guestbook-browser.mjs';

const [slot, output] = process.argv.slice(2);
const probe = await context(slot, output, { queueName: 'imports' });
const runtime = queueRuntime(probe);
await runtime.pause(probe.slot, 'imports');
const initial = await probe.state(), version = initial[0].deployment.version;
assert.equal(initial[1].deployment.version, version);
await assert.rejects(runtime.resume(probe.slot, 'imports', 'unapproved-version'), /approved runtime version/);
assert.equal((await runtime.status(probe.slot, 'imports')).paused, true);
await runtime.resume(probe.slot, 'imports', version);
await runtime.pause(probe.slot, 'imports');
await probe.save('resident', { version, status: await runtime.status(probe.slot, 'imports') });
await probe.compose(['stop', '-t', '0', ...probe.slot.nodes]);
await probe.compose(['start', ...probe.slot.nodes]);
await expect.poll(async () => {
  try { return (await probe.state()).every(node => node.deployment?.version === version); } catch { return false; }
}, { timeout: 120000 }).toBe(true);
const cold = await probe.state();
assert.ok(cold.every(node => !Object.keys(node.deployment.cells).some(cell => cell.startsWith('__Queue:'))), 'Must observe a cold queue before testing materialization');
await probe.save('cold-before', cold);
await runtime.resume(probe.slot, 'imports', version);
await probe.save('cold-resumed', { state: await probe.state(), status: await runtime.status(probe.slot, 'imports') });
await runtime.pause(probe.slot, 'imports');
console.log('PASS: runtime gate rejects an unapproved version and observes the approved generation and resumes the exact resident and cold queue');
