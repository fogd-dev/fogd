// Ordinary CLI approval with compatible old/new queue handlers around an additive migration.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { context } from './queue-probe/context.mjs';
import { expect } from './guestbook-browser.mjs';
import { request } from './http.mjs';
import { stackRoot, run } from '../packages/cli/src/local.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';

const probe = await context('slot-1', process.argv[2], { queueName: 'imports-public-imports' });
const app = 'imports-public', source = join(stackRoot, 'examples/imports'), project = join(probe.output, 'project');
const cli = args => execute(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), ...args], { env: probe.env });
const auth = { Authorization: `Basic ${Buffer.from(`${probe.env.FOGD_ADMIN_USER}:${probe.env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` };
async function admin() { const r = await fetch(`http://127.0.0.1:${probe.env.FOGD_ADMIN_PORT}/v1/admin`, { headers: auth }); assert.equal(r.status, 200); return r.json(); }
const gateway = (path, options = {}) => request(`http://127.0.0.1:${probe.env.FOGD_HTTP_PORT}${path}`, { ...options, headers: { Host: `${app}.localhost`, 'Content-Type': 'application/json' } });
async function job(id) { const r = await gateway(`/api/imports?id=${id}`); assert.equal(r.status, 200); return r.json(); }
async function post(body) { const r = await gateway('/api/imports', { method: 'POST', body: JSON.stringify(body) }); assert.equal(r.status, 202, await r.text()); }
probe.config.services.controller.environment.FOGD_QUEUE_APPS = '1';
await writeFile(probe.env.FOGD_COMPOSE_FILE, JSON.stringify(probe.config, null, 2) + '\n');
await probe.compose(['up', '-d', '--pull', 'never', 'controller']);
await expect.poll(async () => { try { return (await admin()).apps[app]?.route; } catch { return null; } }, { timeout: 120000 }).toBe('active');
const before = await admin(), old = before.deployments[before.apps[app].active];
const initialQueue = await probe.queue('info');
assert.equal(initialQueue.backlogCount, 0); assert.equal(initialQueue.stored, 0);
assert.ok(!before.apps[app].migrations.some(m => m.name === '0002_processor.sql'), 'The additive migration must not already be applied');
await mkdir(project);
for (const name of ['package.json', 'vite.config.ts', 'void.config.ts', 'tsconfig.json', 'fogd.json', 'routes', 'lib', 'queues', 'db']) await cp(join(source, name), join(project, name), { recursive: true });
await cp(join(source, 'updates/v2'), project, { recursive: true, force: true });
const credential = JSON.parse(await cli(['admin', 'issue-token', 'queue-update-qualification', app]));
const log = await run(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), 'deploy', '--name', app], { cwd: project, env: { ...probe.env, FOGD_DEPLOY_TOKEN: credential.token }, capture: true });
await writeFile(join(probe.output, 'deploy.log'), log, { mode: 0o600 });
const submitted = await admin(), added = Object.values(submitted.deployments).filter(r => !Object.hasOwn(before.deployments, r.id));
assert.equal(added.length, 1); const update = added[0]; assert.equal(update.status, 'pending');
assert.equal(submitted.apps[app].active, old.id);
const heldId = `held-${randomUUID()}`, pendingId = `pending-${randomUUID()}`;
const delayMs = (probe.budget - 3) * 1000;
let failure;
try {
  await cli(['admin', 'delivery', app, 'resume', old.id, old.digest]);
  await post({ id: heldId, text: 'mango', delayMs });
  await expect.poll(async () => (await job(heldId)).attempts, { timeout: 120000 }).toBe(1);
  await cli(['admin', 'delivery', app, 'pause']);
  await post({ id: pendingId, text: 'guava' });
  const started = Date.now();
  await cli(['admin', 'approve', update.id, update.digest]);
  const approvalMs = Date.now() - started;
  assert.ok((await admin()).apps[app].migrations.some(m => m.name === '0002_processor.sql'));
  const migrated = { held: await job(heldId), pending: await job(pendingId), queue: await probe.queue('info') };
  await probe.save('migrated-before-resume', { old: old.id, update: update.id, delayMs, approvalMs, ...migrated });
  assert.equal(migrated.held.status, 'accepted', 'Old handler must still be in flight after approval');
  assert.equal(migrated.pending.status, 'accepted'); assert.equal(migrated.pending.attempts, 0); assert.equal(migrated.queue.paused, true);
  await cli(['admin', 'delivery', app, 'resume', update.id, update.digest]);
  await expect.poll(async () => (await job(pendingId)).status, { timeout: 120000 }).toBe('complete');
  assert.equal((await job(heldId)).status, 'accepted', 'New handler must complete while the old handler remains in flight');
  await expect.poll(async () => (await job(heldId)).status, { timeout: 120000 }).toBe('complete');
  const held = await job(heldId), pending = await job(pendingId);
  assert.deepEqual(held.results.map(r => r.processor), ['v1']); assert.deepEqual(pending.results.map(r => r.processor), ['v2']);
  assert.equal(held.attempts, 1); assert.equal(pending.attempts, 1);
  await expect.poll(async () => (await probe.queue('info')).stored, { timeout: 120000 }).toBe(0);
  await probe.save('update', { source: probe.config.name, old: { id: old.id, digest: old.digest }, update: { id: update.id, digest: update.digest }, delayMs, approvalMs, held, pending });
  console.log('PASS: normal CLI approval preserves v1 in-flight work while v2 processes pending work across an additive migration');
} catch (error) { failure = error; throw error; } finally {
  try { await cli(['admin', 'delivery', app, 'pause']); }
  catch (error) { throw failure ? new AggregateError([failure, error], 'Update probe failed and final pause also failed') : error; }
}
