// Continue a private retirement fixture with its restored installation selected.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { context } from './context.mjs';
import { stackRoot } from '../../packages/cli/src/local.mjs';
import { execute } from '../../packages/cli/src/recovery/execute.mjs';
import { expect } from '../guestbook-browser.mjs';
import { request } from '../http.mjs';
const probe = await context('slot-1', process.argv[2], { queueName: 'imports' });
const auth = { Authorization: `Basic ${Buffer.from(`${probe.env.FOGD_ADMIN_USER}:${probe.env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` };
const origin = `http://127.0.0.1:${probe.env.FOGD_ADMIN_PORT}`;
async function admin(path = '/v1/admin') { const r = await fetch(origin + path, { headers: auth }); assert.equal(r.status, 200); return r.json(); }
await expect.poll(async () => { try { return (await admin()).apps.imports?.route; } catch { return null; } }, { timeout: 120000 }).toBe('retired');
const state = await admin(), oldPrefix = state.apps.imports.retirement.previous.prefix;
assert.equal(state.apps.survivor.queueRecovery.status, 'pending');
assert.equal(state.apps.survivor.route, 'paused');
assert.equal(state.apps.imports.delivery, undefined);
assert.ok(state.apps.imports.retirement.queue.snapshot.backlogCount >= 1, 'Retirement must retain the pending-work audit');
const gateway = (name, path, options = {}) => request(`http://127.0.0.1:${probe.env.FOGD_HTTP_PORT}${path}`, { ...options, headers: { ...options.headers, Host: `${name}.localhost` } });
assert.equal((await gateway('imports', '/api/imports')).status, 404);
async function objects(prefix) {
  const code = `import {createRequire} from 'node:module';import {bucketClient} from './packages/runtime/src/bucket.mjs';const require=createRequire('/app/packages/platform/src/backend.mjs');const {ListObjectsV2Command}=require('@aws-sdk/client-s3');let token;const objects=[];do{const r=await bucketClient().send(new ListObjectsV2Command({Bucket:process.env.FOGD_BUCKET,Prefix:${JSON.stringify(prefix + '/')},ContinuationToken:token}));objects.push(...(r.Contents||[]).map(o=>({key:o.Key,etag:o.ETag,size:o.Size})));token=r.NextContinuationToken;}while(token);console.log(JSON.stringify(objects.sort((a,b)=>a.key.localeCompare(b.key))));`;
  return JSON.parse(await probe.node(code));
}
const retained = await objects(oldPrefix); assert.ok(retained.length > 0);
assert.deepEqual(await objects(probe.slot.prefix), []);
await probe.save('before-replacement', { oldPrefix, retained, replacementPrefix: probe.slot.prefix });
await probe.compose(['stop', 'controller']);
await probe.compose(['run', '--rm', '--no-deps', '-T', '-v', `${join(stackRoot, 'scripts/queue-probe')}:/tmp/qualification:ro`, 'controller', 'node', '/tmp/qualification/retirement-stage.mjs', 'survivor', 'replacement']);
await probe.compose(['up', '-d', '--pull', 'never', 'controller']);
await expect.poll(async () => { try { return (await admin()).apps.replacement?.route; } catch { return null; } }, { timeout: 120000 }).toBe('active');
const initial = await probe.queue('info'); assert.equal(initial.backlogCount, 0); assert.equal(initial.paused, true);
const jobs = await gateway('replacement', '/api/imports'); assert.equal(jobs.status, 200); assert.deepEqual(await jobs.json(), []);
const cli = args => execute(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), ...args], { env: probe.env });
const id = `replacement-${Date.now()}`;
const submitted = await gateway('replacement', '/api/imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text: 'new\nfleet' }) });
assert.equal(submitted.status, 202);
const current = await admin('/v1/apps/replacement/delivery');
await cli(['admin', 'delivery', 'replacement', 'resume', current.active.deployment, current.active.digest]);
await expect.poll(async () => (await (await gateway('replacement', '/api/imports?id=' + id)).json()).status, { timeout: 120000 }).toBe('complete');
await cli(['admin', 'delivery', 'replacement', 'pause']);
assert.deepEqual(await objects(oldPrefix), retained);
assert.equal((await admin()).apps.survivor.queueRecovery.status, 'pending');
await probe.save('isolation', { oldPrefix, retainedObjectCount: retained.length, unchangedAfterReplacement: true, initialQueue: initial, replacementJob: await (await gateway('replacement', '/api/imports?id=' + id)).json(), survivorStillPending: true });
console.log('PASS: fresh queue and D1, replacement processes new work, retained prefix unchanged');
