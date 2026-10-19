import { prefixFingerprints } from './prefix-fingerprints.mjs';
// Qualify source-prefix preservation and zero-live queued Docker recovery.
// Requires the stopped retirement-isolation fixture with replacement and survivor.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configEnv, stackRoot } from '../../packages/cli/src/local.mjs';
import { resolvedCompose } from '../../packages/cli/src/compose/config.mjs';
import { composeArgs, json } from '../../packages/cli/src/recovery/docker.mjs';
import { execute } from '../../packages/cli/src/recovery/execute.mjs';
import { backup } from '../../packages/cli/src/recovery/backup.mjs';
import { retire } from '../../packages/cli/src/recovery/retire.mjs';
import { restore } from '../../packages/cli/src/recovery/restore.mjs';
import { expect } from '../guestbook-browser.mjs';
import { request } from '../http.mjs';

const output = resolve(process.argv[2]); await mkdir(output, { mode: 0o700 });
const env = await configEnv();
let config = await resolvedCompose(env), file = env.FOGD_COMPOSE_FILE, project = config.name;
assert.match(project, /^fogd-m11[a-z0-9-]*$/);
const [image] = await json(['image', 'inspect', 'fogd-runtime:local']);
const evidence = process.argv[3] ? JSON.parse(await readFile(resolve(process.argv[3]))) : { image: image.Id, retirements: [] };
assert.equal(evidence.image, image.Id);
const previous = config.services.controller.image;
for (const service of Object.values(config.services)) if (service.image === previous) service.image = image.Id;
await writeFile(file, JSON.stringify(config, null, 2) + '\n');
const compose = args => execute('docker', [...composeArgs(file, project), ...args]);
const auth = { Authorization: `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` };
const origin = `http://127.0.0.1:${env.FOGD_ADMIN_PORT}`;
async function admin(path = '/v1/admin') { const r = await fetch(origin + path, { headers: auth }); assert.equal(r.status, 200); return r.json(); }
async function ready() { await expect.poll(async () => { try { return Object.keys((await admin()).apps).length; } catch { return 0; } }, { timeout: 120000 }).toBe(3); }
const cli = args => execute(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), ...args], { env });
const gateway = (name, path, options = {}) => request(`http://127.0.0.1:${env.FOGD_HTTP_PORT}${path}`, { ...options, headers: { ...options.headers, Host: `${name}.localhost` } });
async function acknowledge(name) {
  let delivery = await admin(`/v1/apps/${name}/delivery`);
  if (delivery.recovery?.status !== 'pending') return;
  const check = `const state=JSON.parse(await (await import('node:fs/promises')).readFile('/var/lib/fogd/state.json'));const app=state.apps[${JSON.stringify(name)}];const expected=state.deployments[app.active].version;const slot=JSON.parse(process.env.FOGD_SLOTS).find(s=>s.id===app.slot);const versions=await Promise.all(slot.nodes.map(async n=>(await (await fetch('http://'+n+':8081/state')).json()).deployment?.version));console.log(JSON.stringify(versions.every(v=>v===expected)));`;
  await expect.poll(async () => { try { return JSON.parse(await compose(['exec', '-T', 'controller', 'node', '--input-type=module', '-e', check])); } catch { return false; } }, { timeout: 120000 }).toBe(true);
  const ack = () => cli(['admin', 'recover', name, delivery.active.deployment, delivery.active.digest, delivery.recovery.id, delivery.recovery.review, '--accept-possible-loss']);
  try { await ack(); } catch {
    const refreshed = await admin(`/v1/apps/${name}/delivery`);
    assert.notEqual(refreshed.recovery.review, delivery.recovery.review); delivery = refreshed; await ack();
  }
  assert.equal((await admin(`/v1/apps/${name}/delivery`)).desired, 'paused');
}
const fingerprints = (prefix, running) => prefixFingerprints(compose, prefix, running);
function select(destination, target) {
  file = join(destination, 'compose.json'); project = target;
  process.env.FOGD_COMPOSE_FILE = file; process.env.COMPOSE_PROJECT_NAME = project;
}
await compose(['up', '-d', '--pull', 'never']); await ready();
for (const retired of evidence.retirements) assert.deepEqual(await fingerprints(retired.prefix, true), retired.sourceAndRestoredObjects);
for (const name of ['replacement', 'survivor']) {
  if ((await admin()).apps[name].retirement) {
    assert.ok(evidence.retirements.some(value => value.name === name), 'Resume requires prior source-prefix evidence');
    continue;
  }
  await acknowledge(name);
  const state = await admin(), app = state.apps[name], active = state.deployments[app.active];
  await expect.poll(async () => { try { return (await gateway(name, '/api/imports')).status; } catch { return 0; } }, { timeout: 120000 }).toBe(200);
  const id = `retirement-${name}-${Date.now()}`;
  const accepted = await gateway(name, '/api/imports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text: 'retained\npending' }) });
  assert.equal(accepted.status, 202);
  const bundle = join(output, `${name}-snapshot`);
  const manifest = await backup(bundle);
  assert.ok(manifest.queueRecovery.apps[name].observation.backlogCount >= 1);
  const prefix = JSON.parse(config.services.controller.environment.FOGD_SLOTS).find(slot => slot.id === app.slot).prefix;
  // Only bucket service runs; app replicas/controller remain stopped throughout source observation.
  await compose(['up', '-d', '--no-deps', 'minio']);
  const before = await fingerprints(prefix, false); assert.ok(before.length > 0);
  await compose(['stop', 'minio']);
  // Retain volumes and release the disposable project's limited network addresses.
  await compose(['down']);
  const target = `fogd-m11a-retired-${name}-${Date.now()}`, destination = join(output, `${name}-retired`);
  await retire(bundle, name, active.digest, target, destination, true);
  select(destination, target); config = JSON.parse(await readFile(file));
  await compose(['up', '-d', '--pull', 'never']); await ready();
  const after = await fingerprints(prefix, true); assert.deepEqual(after, before);
  const retired = (await admin()).apps[name];
  assert.equal(retired.route, 'retired'); assert.equal(retired.delivery, undefined);
  assert.ok(retired.retirement.queue.snapshot.backlogCount >= 1);
  assert.equal((await gateway(name, '/api/imports')).status, 404);
  evidence.retirements.push({ name, jobId: id, prefix, sourceAndRestoredObjects: before, snapshotBacklog: manifest.queueRecovery.apps[name].observation.backlogCount });
  await writeFile(join(output, 'progress.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(`PASS: ${name} pending work retired; source and restored prefix hashes match`);
}
const zeroBundle = join(output, 'zero-live-snapshot');
const manifest = await backup(zeroBundle);
assert.equal(manifest.queueRecovery, undefined);
await compose(['down']);
const target = `fogd-m11a-retired-only-${Date.now()}`, destination = join(output, 'zero-live-restored');
await restore(zeroBundle, target, destination); select(destination, target);
await compose(['up', '-d', '--pull', 'never']); await ready();
const state = await admin();
assert.ok(state.requirements.includes('fogd-queue-retirement-v1'));
for (const [name, app] of Object.entries(state.apps)) {
  assert.equal(app.route, 'retired'); assert.equal(app.delivery, undefined); assert.equal(app.queueRecovery, undefined);
  assert.equal((await gateway(name, '/api/imports')).status, 404);
}
for (const retired of evidence.retirements) assert.deepEqual(await fingerprints(retired.prefix, true), retired.sourceAndRestoredObjects);
await writeFile(join(output, 'complete.json'), JSON.stringify({ ...evidence, zeroLive: { project, composeFile: file, manifestHasQueueRecovery: false, retiredApps: Object.keys(state.apps).sort(), controllerReady: true, preservedPrefixes: true } }, null, 2) + '\n', { mode: 0o600 });
console.log('PASS: zero-live queued-history backup and ordinary restore start successfully with retained prefixes');
