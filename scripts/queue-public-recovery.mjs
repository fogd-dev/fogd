// Recover duplicate pending messages from an ordinarily deployed canonical artifact.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { context } from './queue-probe/context.mjs';
import { restoreAndQualify } from './queue-probe/installation-recovery.mjs';
import { request } from './http.mjs';
import { expect } from './guestbook-browser.mjs';
import { backup } from '../packages/cli/src/recovery/backup.mjs';

const [output, target] = process.argv.slice(2);
assert.match(target || '', /^fogd-m11[a-z0-9-]*$/);
const app = 'imports-public', queueName = `${app}-imports`;
const probe = await context('slot-1', output, { queueName });
assert.notEqual(target, probe.config.name);
await probe.compose(['up', '-d', '--pull', 'never']);
const gateway = (path, options = {}) => request(`http://127.0.0.1:${probe.env.FOGD_HTTP_PORT}${path}`, { ...options, headers: { Host: `${app}.localhost`, 'Content-Type': 'application/json' } });
await expect.poll(async () => { try { return (await gateway('/api/imports')).status; } catch { return null; } }, { timeout: 120000 }).toBe(200);
const initial = await probe.queue('info');
assert.equal(initial.paused, true); assert.equal(initial.backlogCount, 0);
const jobId = `public-recovery-${randomUUID()}`;
for (let i = 0; i < 2; i++) {
  const response = await gateway('/api/imports', { method: 'POST', body: JSON.stringify({ id: jobId, text: 'durable\nqueue' }) });
  assert.equal(response.status, 202, await response.text());
}
const pending = await probe.queue('info');
assert.equal(pending.backlogCount, 2); assert.equal(pending.paused, true);
const accepted = await (await gateway(`/api/imports?id=${jobId}`)).json();
assert.equal(accepted.status, 'accepted'); assert.equal(accepted.results.length, 0);
await probe.save('pending', { jobId, queue: pending, job: accepted });
const bundle = join(probe.output, 'snapshot'), destination = join(probe.output, 'restored');
const manifest = await backup(bundle);
assert.equal(manifest.queueRecovery.apps[app].observation.backlogCount, 2);
// Remove this stopped disposable project's containers/network; retain every volume.
await probe.compose(['down']);
const result = await restoreAndQualify(probe, bundle, destination, target, { jobId, app, queueName, backlog: 2 });
assert.ok([1, 2].includes(result.job.attempts), 'At most the two submitted deliveries may process the job');
assert.deepEqual(result.job.results.map(row => row.label).sort(), ['DURABLE', 'QUEUE']);
await probe.save('recovery', { source: probe.config.name, target, app, queueName, activeDeployment: result.finalDelivery.active, pendingDuplicateMessages: 2, snapshotReceipt: manifest.queueRecovery.apps[app].id, ...result });
console.log('PASS: two pending canonical queue messages survive restore, drain after explicit acknowledgment/resume, and produce only two result rows');
