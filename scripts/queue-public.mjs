// Ordinary CLI upload/approval qualification; no private artifact staging.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configEnv, stackRoot, run } from '../packages/cli/src/local.mjs';
import { resolvedCompose } from '../packages/cli/src/compose/config.mjs';
import { composeArgs, json } from '../packages/cli/src/recovery/docker.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { backup } from '../packages/cli/src/recovery/backup.mjs';
import { restore } from '../packages/cli/src/recovery/restore.mjs';
import { prefixFingerprints } from './queue-probe/prefix-fingerprints.mjs';
import { expect } from './guestbook-browser.mjs';
import { request } from './http.mjs';
const output = resolve(process.argv[2]); await mkdir(output, { mode: 0o700 });
const env = await configEnv();
let config = await resolvedCompose(env), file = env.FOGD_COMPOSE_FILE, project = config.name;
assert.match(project, /^fogd-m11[a-z0-9-]*$/);
const [image] = await json(['image', 'inspect', 'fogd-runtime:local']);
const prior = config.services.controller.image;
for (const service of Object.values(config.services)) if (service.image === prior) service.image = image.Id;
config.services.controller.environment.FOGD_QUEUE_APPS = '1';
await writeFile(file, JSON.stringify(config, null, 2) + '\n');
const compose = args => execute('docker', [...composeArgs(file, project), ...args]);
const cli = (args, selected = env) => execute(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), ...args], { env: selected });
const auth = { Authorization: `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` };
const origin = `http://127.0.0.1:${env.FOGD_ADMIN_PORT}`;
async function admin(path = '/v1/admin') { const r = await fetch(origin + path, { headers: auth }); assert.equal(r.status, 200); return r.json(); }
async function ready() { await expect.poll(async () => { try { return (await admin()).capacity.slots.available; } catch { return -1; } }, { timeout: 120000 }).toBe(2); }
const app = 'imports-public';
const gateway = (path, options = {}) => request(`http://127.0.0.1:${env.FOGD_HTTP_PORT}${path}`, { ...options, headers: { ...options.headers, Host: `${app}.localhost` } });
await compose(['up', '-d', '--pull', 'never']); await ready();
assert.equal((await admin()).apps[app], undefined);
if (process.argv[3] !== '--submitted') {
const credential = JSON.parse(await cli(['admin', 'issue-token', 'queue-public-qualification', app]));
const deployEnv = { ...env, FOGD_DEPLOY_TOKEN: credential.token };
const build = await run(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), 'deploy', '--name', app], { cwd: join(stackRoot, 'examples/imports'), env: deployEnv, capture: true });
await writeFile(join(output, 'deploy.log'), build, { mode: 0o600 });
}
let state = await admin();
const pending = Object.values(state.deployments).filter(r => r.app === app); assert.equal(pending.length, 1);
const deployment = pending[0]; assert.equal(deployment.status, 'pending');
const credentialScope = state.credentials.find(c => c.id === deployment.submitter)?.apps;
assert.deepEqual(credentialScope, [app]);
assert.equal(deployment.resources.queues.producers[0].queue, 'imports-public-imports');
assert.equal(state.apps[app], undefined); assert.equal((await gateway('/')).status, 404);
for (const slot of JSON.parse(config.services.controller.environment.FOGD_SLOTS)) {
  assert.deepEqual(await prefixFingerprints(compose, slot.prefix + '/deploy', true), []);
  const owner = await compose(['exec', '-T', 'controller', 'node', '--input-type=module', '-e', `import {Backend} from './packages/platform/src/backend.mjs';console.log(JSON.stringify(await new Backend().owner(${JSON.stringify(slot)})));`]);
  assert.equal(JSON.parse(owner), null);
}
await assert.rejects(cli(['admin', 'approve', deployment.id, '0'.repeat(64)]));
const manifest = await backup(join(output, 'pending-snapshot')); assert.equal(manifest.queueRecovery, undefined);
await compose(['down']);
const destination = join(output, 'pending-restored'), target = `fogd-m11a-public-${Date.now()}`;
await restore(join(output, 'pending-snapshot'), target, destination);
file = join(destination, 'compose.json'); project = target; config = JSON.parse(await readFile(file));
await compose(['up', '-d', '--pull', 'never']); await ready();
state = await admin(); assert.equal(state.deployments[deployment.id].status, 'pending'); assert.equal(state.apps[app], undefined);
await cli(['admin', 'approve', deployment.id, deployment.digest]);
await expect.poll(async () => { try { return (await gateway('/api/imports')).status; } catch { return 0; } }, { timeout: 120000 }).toBe(200);
const jobs = [];
for (const mode of ['normal', 'retry-once', 'fail']) {
  const id = `public-${mode}-${Date.now()}`, body = { id, text: 'typed\nqueue', mode };
  const post = value => gateway('/api/imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  assert.equal((await post(body)).status, 202);
  const inspect = async () => (await (await gateway('/api/imports?id=' + id)).json());
  await expect.poll(async () => (await inspect()).status, { timeout: 120000 }).toBe(mode === 'fail' ? 'failed' : 'complete');
  if (mode === 'fail') {
    assert.equal((await inspect()).attempts, 2);
    assert.equal((await post({ id, retry: true })).status, 202);
    await expect.poll(async () => (await inspect()).status, { timeout: 120000 }).toBe('complete');
  }
  const completed = await inspect(); assert.equal(completed.results.length, 2);
  if (mode === 'retry-once') assert.equal(completed.attempts, 2);
  assert.equal((await post(body)).status, 202);
  assert.deepEqual(await inspect(), completed);
  jobs.push(completed);
}
await cli(['admin', 'delivery', app, 'pause']);
await writeFile(join(output, 'public.json'), JSON.stringify({ image: image.Id, app, project, composeFile: file, deployment, credentialScope, pendingSnapshotWithoutQueueRecovery: true, unapprovedDeploymentObjects: 0, wrongDigestRefused: true, jobs, delivery: await admin(`/v1/apps/${app}/delivery`) }, null, 2) + '\n', { mode: 0o600 });
console.log('PASS: normal scoped CLI upload, pending-only backup/restore, exact approval, derived Void queue dispatch and application retry');
