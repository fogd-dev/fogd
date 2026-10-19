// Verify the surviving app's recovery acknowledgment before taking another backup.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { context } from './context.mjs';
import { stackRoot } from '../../packages/cli/src/local.mjs';
import { execute } from '../../packages/cli/src/recovery/execute.mjs';
import { expect } from '../guestbook-browser.mjs';
import { request } from '../http.mjs';
import { backup } from '../../packages/cli/src/recovery/backup.mjs';
const probe = await context('slot-2', process.argv[2], { queueName: 'imports' });
const auth = { Authorization: `Basic ${Buffer.from(`${probe.env.FOGD_ADMIN_USER}:${probe.env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` };
async function delivery() { const r = await fetch(`http://127.0.0.1:${probe.env.FOGD_ADMIN_PORT}/v1/apps/survivor/delivery`, { headers: auth }); assert.equal(r.status, 200); return r.json(); }
const cli = args => execute(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), ...args], { env: probe.env });
let current = await delivery(); assert.equal(current.recovery.status, 'pending');
await assert.rejects(cli(['admin', 'delivery', 'survivor', 'resume', current.active.deployment, current.active.digest]));
async function acknowledge() { await cli(['admin', 'recover', 'survivor', current.active.deployment, current.active.digest, current.recovery.id, current.recovery.review, '--accept-possible-loss']); }
try { await acknowledge(); } catch {
  const refreshed = await delivery(); assert.notEqual(refreshed.recovery.review, current.recovery.review);
  current = refreshed; await acknowledge();
}
assert.equal((await probe.queue('info')).paused, true);
const gateway = (path, options = {}) => request(`http://127.0.0.1:${probe.env.FOGD_HTTP_PORT}${path}`, { ...options, headers: { ...options.headers, Host: 'survivor.localhost' } });
assert.deepEqual(await (await gateway('/api/imports')).json(), []);
const id = `survivor-${Date.now()}`;
assert.equal((await gateway('/api/imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text: 'surviving\napplication' }) })).status, 202);
await cli(['admin', 'delivery', 'survivor', 'resume', current.active.deployment, current.active.digest]);
await expect.poll(async () => (await (await gateway('/api/imports?id=' + id)).json()).status, { timeout: 120000 }).toBe('complete');
await cli(['admin', 'delivery', 'survivor', 'pause']);
const job = await (await gateway('/api/imports?id=' + id)).json();
const manifest = await backup(join(probe.output, 'snapshot'));
assert.deepEqual(Object.keys(manifest.queueRecovery.apps).sort(), ['replacement', 'survivor']);
await probe.save('survivor', { job, preparedApps: Object.keys(manifest.queueRecovery.apps).sort(), retiredExcluded: !Object.hasOwn(manifest.queueRecovery.apps, 'imports') });
console.log('PASS: survivor acknowledges and completes new work; backup excludes retired queues');
