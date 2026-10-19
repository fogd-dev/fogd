import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { context, deploy, upload, requireEmptyFleet } from './queue-probe/context.mjs';
import { stageNative } from './queue-probe/native.mjs';
import { expect } from './guestbook-browser.mjs';

const [slot, output] = process.argv.slice(2);
const probe = await context(slot, output, { queueName: 'imports' });
await requireEmptyFleet(probe);
const stage = await stageNative(join(probe.output, 'app'));
await deploy(probe, stage.bootstrap, 'native-bootstrap');
await probe.queue('pause');
const project = await upload(probe, stage.output, 'native');
await probe.cli(['d1', 'migrations', 'apply', stage.config.d1_databases[0].database_name, project]);
assert.equal((await probe.http('/')).status, 503);
await probe.save('bootstrap-migration', { applicationStatus: 503, queue: await probe.queue('info') });
console.log('PASS: D1 migration works under producer-only bootstrap before any application publication');
await deploy(probe, stage.output, 'native');
assert.equal((await probe.http('/')).status, 200);
await post({ id: 'first', text: 'apple\npear' });
await post({ id: 'first', text: 'apple\npear' });
await setTimeout(2000);
assert.equal((await job('first')).status, 'accepted'); assert.equal((await job('first')).results.length, 0);
assert.equal((await probe.queue('info')).paused, true);
assert.equal((await job('first')).attempts, 0);
assert.equal((await probe.queue('info')).stored, 2);
await probe.queue('resume'); await completed('first');
await expect.poll(async () => (await probe.queue('info')).stored, { timeout: 120000 }).toBe(0);
assert.equal((await job('first')).attempts, 1);
await post({ id: 'first', text: 'apple\npear' });
assert.equal((await job('first')).results.length, 2);
const conflict = await probe.http('/api/imports', { method: 'POST', body: JSON.stringify({ id: 'first', text: 'changed' }) });
assert.equal(conflict.status, 409);
console.log('PASS: native Void typed producer/consumer, R2 input, D1 results, and idempotent submission');
await post({ id: 'transient', text: 'plum', mode: 'retry-once' }); await completed('transient');
assert.equal((await job('transient')).attempts, 2);
await post({ id: 'poison', text: 'lime', mode: 'fail' });
await expect.poll(async () => (await job('poison')).status, { timeout: 120000 }).toBe('failed');
await expect.poll(async () => (await probe.queue('info')).stored, { timeout: 120000 }).toBe(0);
await post({ id: 'poison', retry: true }); await completed('poison');
assert.equal((await job('poison')).results.length, 1);
await probe.save('jobs', { first: await job('first'), transient: await job('transient'), retried: await job('poison') });
await probe.queue('pause');
console.log('PASS: transient retry and explicit replay after exhaustion preserve input and avoid duplicate business rows');

async function post(body) {
  const response = await probe.http('/api/imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(response.status, 202, response.body); return JSON.parse(response.body);
}
async function job(id) {
  const response = await probe.http(`/api/imports?id=${encodeURIComponent(id)}`);
  assert.equal(response.status, 200, response.body); return JSON.parse(response.body);
}
async function completed(id) {
  await expect.poll(async () => (await job(id)).status, { timeout: 120000 }).toBe('complete');
}
