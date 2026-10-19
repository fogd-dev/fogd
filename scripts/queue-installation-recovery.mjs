import { restoreAndQualify } from './queue-probe/installation-recovery.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { context } from './queue-probe/context.mjs';
import { expect } from './guestbook-browser.mjs';
import { backup } from '../packages/cli/src/recovery/backup.mjs';
import { volumeHelper } from '../packages/cli/src/recovery/volumes.mjs';
import { json } from '../packages/cli/src/recovery/docker.mjs';

const [stagedDirectory, output, target, adopted] = process.argv.slice(2);
assert.ok(adopted === undefined || adopted === '--adopted');
assert.match(target || '', /^fogd-m11[a-z0-9-]*$/);
const probe = await context('slot-1', output, { queueName: 'imports' });
assert.notEqual(target, probe.config.name);
const staged = JSON.parse(await readFile(join(resolve(stagedDirectory), 'controller.json')));
assert.match(staged.dir, /^\/var\/lib\/fogd\/qualification-[a-f0-9-]+$/);
const auth = { Authorization: `Basic ${Buffer.from(`${probe.env.FOGD_ADMIN_USER}:${probe.env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` };
const origin = `http://127.0.0.1:${probe.env.FOGD_ADMIN_PORT}`;
async function admin(path = '/v1/admin') { const r = await fetch(origin + path, { headers: auth }); assert.equal(r.status, 200); return r.json(); }
if (!adopted) {
assert.deepEqual(Object.keys((await admin()).apps), [], 'Adoption requires an empty public controller');
await probe.compose(['stop', 'controller']);
const code = `import {cp,readdir} from 'node:fs/promises'; const source=${JSON.stringify(staged.dir.replace('/var/lib/fogd/', '/data/'))}; for(const name of await readdir(source))await cp(source+'/'+name,'/data/'+name,{recursive:true,force:true});`;
await volumeHelper(probe.config.services.controller.image, probe.config.volumes.controller.name, ['node', '--input-type=module', '-e', code], { readonly: false });
}
const [latest] = await json(['image', 'inspect', 'fogd-runtime:local']);
const prior = probe.config.services.controller.image;
for (const service of Object.values(probe.config.services)) if (service.image === prior) service.image = latest.Id;
await writeFile(probe.env.FOGD_COMPOSE_FILE, JSON.stringify(probe.config, null, 2) + '\n');
await probe.compose(['up', '-d', '--pull', 'never']);
await expect.poll(async () => { try { return (await admin()).apps.imports?.route; } catch { return null; } }, { timeout: 120000 }).toBe('active');
await expect.poll(async () => { try { return (await probe.queue('info')).paused; } catch { return null; } }, { timeout: 120000 }).toBe(true);
console.log('Adopted private artifact; restarted replicas confirm persisted pause');
const jobId = `stopped-recovery-${randomUUID()}`;
const submitted = await probe.http('/api/imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: jobId, text: 'durable\nqueue' }) });
assert.equal(submitted.status, 202, submitted.body);
const pending = await probe.queue('info'); assert.equal(pending.backlogCount, 1);
const bundle = join(probe.output, 'snapshot'), destination = join(probe.output, 'restored');
const manifest = await backup(bundle);
assert.equal(manifest.queueRecovery.apps.imports.observation.backlogCount, 1);
const result = await restoreAndQualify(probe, bundle, destination, target, { jobId });
await probe.save('recovery', { source: probe.config.name, target, controllerImage: latest.Id, privateArtifactAdoption: true, snapshotReceipt: manifest.queueRecovery.apps.imports.id, ...result });
console.log('PASS: pending work survives stopped restore and explicit acknowledgment/resume');
