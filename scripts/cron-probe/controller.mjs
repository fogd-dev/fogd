// Private qualification only. Ordinary cron artifact admission stays closed.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { Controller } from '/app/packages/platform/src/controller.mjs';
import { Backend } from '/app/packages/platform/src/backend.mjs';
import { CronRuntime } from '/app/packages/platform/src/cron-runtime.mjs';
import { dispatchFor } from '/app/packages/platform/src/cron-activation.mjs';
import { requireCronCapability } from '/app/packages/platform/src/cron-dispatch.mjs';
import { artifactDigest, resourceIdentity } from '/app/packages/runtime/src/artifact.mjs';

const slot = JSON.parse(process.env.FOGD_SLOTS).find(value => value.id === process.argv[2]);
assert.ok(slot);
const backend = new Backend();
backend.crons = new CronRuntime({ run: (slot, args) => backend.run(slot, args), inspect: node => backend.deployment(node) });
assert.equal(await backend.owner(slot), null); assert.equal(await backend.hasDeployment(slot), false);
const dir = join(process.env.FOGD_DATA_DIR || '/var/lib/fogd', `cron-qualification-${randomUUID()}`);
const create = () => new Controller({ cronApps: true, dir, slots: [slot], backend });
let controller = create(); await controller.init();
const selected = await controller.replaceSecrets('refresh', { REFRESH_TOKEN: randomBytes(32).toString('hex') });
const initial = await stage('1');
const preapprovalBoundary = await boundary();
assert.equal(await backend.hasDeployment(slot), false, 'A staged cron artifact must remain inert across a minute');

let heldMigration, delay = true;
const migrate = backend.migrate.bind(backend);
backend.migrate = async (...args) => {
  if (delay) {
    delay = false;
    const before = await backend.crons.status(slot, 'refresh'); assert.equal(before.paused, true);
    const at = await boundary();
    const after = await backend.crons.status(slot, 'refresh'); assert.equal(after.paused, true);
    heldMigration = { boundary: at, before, after, replicas: await replicas() };
  }
  return migrate(...args);
};
const resume = backend.crons.resume.bind(backend.crons);
let loseResponse = true;
backend.crons.resume = async (...args) => {
  const result = await resume(...args);
  if (loseResponse) { loseResponse = false; throw Error('Probe: lost successful cron resume response'); }
  return result;
};
const claim = backend.claim.bind(backend);
backend.claim = async (...args) => {
  const durable = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  const approval = Object.values(durable.deployments).find(value => value.status === 'activating');
  assert.ok(approval); assert.equal(approval.secretRevision, selected.revision);
  assert.equal(approval.digest, await artifactDigest(controller.artifact(approval.id)));
  return claim(...args);
};
await approve(initial);
assert.equal(initial.status, 'failed', initial.error);
assert.match(initial.error, /Private activation failed/);
assert.equal(controller.state.apps.refresh.dispatch.hold, initial.id);
const uncertainRelease = await backend.crons.status(slot, 'refresh'); assert.equal(uncertainRelease.paused, false);
controller = create(); await controller.init();
const recovered = await backend.crons.status(slot, 'refresh'); assert.equal(recovered.paused, true);
assert.equal(controller.route('refresh.localhost').state, 'paused');
const retried = controller.state.deployments[initial.id]; await approve(retried);
assert.equal(retried.status, 'active', retried.error);
const firstRows = await waitForTick();
assert.ok(firstRows.every(row => row.revision === '1' && row.secret_ready === 1));
await controller.exclusive(() => dispatchFor(controller, controller.state.apps.refresh, slot).pause());
const update = await stage('2'); await approve(update); assert.equal(update.status, 'active', update.error);
assert.notEqual(update.version, retried.version);
const heldUpdate = await backend.crons.status(slot, 'refresh'); assert.equal(heldUpdate.paused, true);
const updateBoundary = await boundary(); assert.deepEqual(await rows(), firstRows);
const state = controller.state.apps.refresh;
assert.equal(state.dispatch.desired, 'paused'); assert.equal(state.dispatch.hold, null);
const observedReplicas = await replicas(); assert.ok(observedReplicas.every(value => value.version === update.version));
console.log(JSON.stringify({ dir, slot: slot.id, preapprovalBoundary, heldMigration, uncertainRelease, recovered,
  firstRows, heldUpdate, updateBoundary, finalRows: await rows(), dispatch: state.dispatch,
  first: { digest: retried.digest, version: retried.version }, update: { digest: update.digest, version: update.version },
  replicas: observedReplicas, exactApprovalAndSecretPinnedBeforeClaim: true,
  scope: 'Internally staged raw Worker through the real controller and native runtime. Controller object reload follows a lost resume response. Ordinary Void admission, native process-kill activation and snapshot recovery remain unqualified.' }));

async function approve(request) { return controller.mutate(request.id, request.digest, 'approve', selected.revision); }
async function replicas() { return Promise.all(slot.nodes.map(async node => ({ node, ...await backend.deployment(node) }))); }
async function boundary() {
  const at = Math.floor(Date.now() / 60000 + 1) * 60000;
  while (Date.now() < at + 1500) await new Promise(resolve => setTimeout(resolve, 250));
  return at;
}
async function rows() {
  const response = await fetch(`http://${slot.nodes[0]}:8080/`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200); return response.json();
}
async function waitForTick() {
  const end = Date.now() + 80000;
  while (Date.now() < end) { const found = await rows(); if (found.length) return found; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw Error('No native scheduled result before deadline');
}
async function stage(revision) {
  const id = randomUUID(), artifact = controller.artifact(id);
  await mkdir(join(artifact, 'worker'), { recursive: true }); await mkdir(join(artifact, 'migrations/DB'), { recursive: true });
  const sql = 'CREATE TABLE ticks (cron TEXT NOT NULL, scheduled_time INTEGER NOT NULL, ran_at INTEGER NOT NULL, revision TEXT NOT NULL, secret_ready INTEGER NOT NULL, PRIMARY KEY (cron, scheduled_time));\n';
  await writeFile(join(artifact, 'migrations/DB/0001_ticks.sql'), sql);
  await writeFile(join(artifact, 'worker/index.js'), `export default {
    async fetch(request,env) {
      if(new URL(request.url).pathname==='/__void/ready') { await env.DB.prepare('SELECT 1 FROM ticks LIMIT 1').all(); return Response.json({ready:!!env.REFRESH_TOKEN}); }
      return Response.json((await env.DB.prepare('SELECT * FROM ticks ORDER BY scheduled_time,cron').all()).results);
    },
    async scheduled(event,env) {
      if(!env.REFRESH_TOKEN) throw Error('Missing required configuration');
      await env.DB.prepare('INSERT OR IGNORE INTO ticks VALUES (?,?,?,?,?)').bind(event.cron,event.scheduledTime,Date.now(),env.APP_REVISION,1).run();
    }
  };\n`);
  const config = { name: 'refresh', main: 'worker/index.js', no_bundle: true, compatibility_date: '2026-01-01',
    vars: { APP_REVISION: revision }, triggers: { crons: ['* * * * *'] },
    d1_databases: [{ binding: 'DB', database_name: 'refresh-db', database_id: 'refresh-db', migrations_dir: 'migrations/DB' }],
    r2_buckets: [], durable_objects: { bindings: [] } };
  await writeFile(join(artifact, 'wrangler.json'), JSON.stringify(config));
  const request = { id, app: 'refresh', digest: await artifactDigest(artifact), resources: { ...resourceIdentity(config), crons: config.triggers.crons },
    migrations: [{ database: 'refresh-db', name: '0001_ticks.sql', digest: createHash('sha256').update(sql).digest('hex') }],
    requiredSecrets: ['REFRESH_TOKEN'], status: 'pending', step: 'submitted', submitter: 'private-cron-qualification' };
  requireCronCapability(controller.state, request.resources);
  controller.state.deployments[id] = request; await controller.save(); return request;
}
