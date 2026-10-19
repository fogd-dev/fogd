import assert from 'node:assert/strict';
import { join } from 'node:path';
import { request } from '../http.mjs';
import { expect } from '../guestbook-browser.mjs';
import { restore } from '../../packages/cli/src/recovery/restore.mjs';
import { composeArgs } from '../../packages/cli/src/recovery/docker.mjs';
import { execute } from '../../packages/cli/src/recovery/execute.mjs';
import { stackRoot } from '../../packages/cli/src/local.mjs';

export async function restoreAndQualify(probe, bundle, destination, target, { jobId: selectedJob = null, mode = 'all', app = 'imports', queueName = 'imports', backlog = 1 } = {}) {
let jobId = selectedJob;
const auth = { Authorization: `Basic ${Buffer.from(`${probe.env.FOGD_ADMIN_USER}:${probe.env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` };
const origin = `http://127.0.0.1:${probe.env.FOGD_ADMIN_PORT}`;
async function admin(path) { const r = await fetch(origin + path, { headers: auth }); assert.equal(r.status, 200); return r.json(); }
await restore(bundle, target, destination);
const command = composeArgs(join(destination, 'compose.json'), target);
const compose = args => execute('docker', [...command, ...args]);
await compose(mode === 'all' ? ['up', '-d', '--pull', 'never'] : ['up', '-d', '--pull', 'never', 'minio', 'bucket-init', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b']);
const bucket = probe.config.services.controller.environment.FOGD_BUCKET;
const queue = () => compose(['run', '--rm', '--no-deps', '-T', '-e', `CELLD_BUCKET=s3://${bucket}/${probe.slot.prefix}`, 'controller', 'celld', 'queue', 'info', queueName, '--json']).then(JSON.parse);
await expect.poll(async () => { try { return (await queue()).paused; } catch { return null; } }, { timeout: 120000 }).toBe(true);
const beforeController = await queue(); assert.equal(beforeController.backlogCount, backlog);
if (!jobId) {
  const inspect = "const r=await fetch(" + JSON.stringify(`http://${probe.slot.nodes[0]}:8080/api/imports`) + ");if(!r.ok)throw Error('job inspection');console.log(JSON.stringify((await r.json()).filter(j=>j.status==='accepted').map(j=>j.id)));";
  const jobs = JSON.parse(await compose(['run', '--rm', '--no-deps', '-T', 'controller', 'node', '--input-type=module', '-e', inspect]));
  assert.equal(jobs.length, 1); jobId = jobs[0];
}
await probe.save(mode === 'all' ? 'after-simultaneous-start' : 'before-controller', beforeController);
if (mode !== 'all') await compose(['up', '-d', '--pull', 'never', 'controller', 'workerd']);
await expect.poll(async () => { try { return (await admin(`/v1/apps/${app}/delivery`)).recovery?.status; } catch { return null; } }, { timeout: 120000 }).toBe('pending');
let delivery = await admin(`/v1/apps/${app}/delivery`); assert.equal(delivery.resumeAllowed, false);
const generationCheck = `const state=JSON.parse(await (await import('node:fs/promises')).readFile('/var/lib/fogd/state.json')); const expected=state.deployments[state.apps[${JSON.stringify(app)}].active].version; const nodes=${JSON.stringify(probe.slot.nodes)}; const versions=await Promise.all(nodes.map(async n=>(await (await fetch('http://'+n+':8081/state')).json()).deployment?.version)); console.log(JSON.stringify(versions.every(v=>v===expected)));`;
await expect.poll(async () => { try { return JSON.parse(await compose(['exec', '-T', 'controller', 'node', '--input-type=module', '-e', generationCheck])); } catch { return false; } }, { timeout: 120000 }).toBe(true);
const gateway = path => request(`http://127.0.0.1:${probe.env.FOGD_HTTP_PORT}${path}`, { headers: { Host: `${app}.localhost` } });
assert.equal((await gateway('/api/imports?id=' + encodeURIComponent(jobId))).status, 503);
const cli = args => execute(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), ...args], { env: probe.env });
await assert.rejects(cli(['admin', 'delivery', app, 'resume', delivery.active.deployment, delivery.active.digest]));
const acknowledge = () => cli(['admin', 'recover', app, delivery.active.deployment, delivery.active.digest, delivery.recovery.id, delivery.recovery.review, '--accept-possible-loss']);
let reviewChanged = false;
try { await acknowledge(); } catch {
  const updated = await admin(`/v1/apps/${app}/delivery`);
  assert.notEqual(updated.recovery.review, delivery.recovery.review, 'Only changed recovery findings permit this probe retry');
  delivery = updated; reviewChanged = true; await acknowledge();
}
assert.equal((await queue()).paused, true);
assert.equal((await (await gateway('/api/imports?id=' + encodeURIComponent(jobId))).json()).status, 'accepted');
await cli(['admin', 'delivery', app, 'resume', delivery.active.deployment, delivery.active.digest]);
await expect.poll(async () => (await (await gateway('/api/imports?id=' + encodeURIComponent(jobId))).json()).status, { timeout: 120000 }).toBe('complete');
await expect.poll(async () => { const info = await queue(); return [info.backlogCount, info.stored]; }, { timeout: 120000 }).toEqual([0, 0]);
const job = await (await gateway('/api/imports?id=' + encodeURIComponent(jobId))).json(); assert.equal(job.results.length, 2);
await cli(['admin', 'delivery', app, 'pause']);
return { startupMode: mode, reviewChanged, initialQueue: beforeController, recovery: delivery.recovery, job, finalDelivery: await admin(`/v1/apps/${app}/delivery`) };
}
