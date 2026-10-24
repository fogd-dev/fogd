import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { artifactDigest } from '@fogd/runtime/artifact';
import { Controller } from '../src/controller.mjs';
import { initializeFreshRouteStores } from '../src/fresh-route-enrollment.mjs';
import { prepareRouteRestoration, restoreEnrolledRouteStores, prepareRetiredRouteRestoration } from '../src/route-restoration.mjs';
import { readRouteRecord, writeRouteRecord } from '../src/route-record-store.mjs';
import { runtimePolicyIdentity } from '../src/runtime-policy.mjs';
import { operateDelivery } from '../src/admin-delivery.mjs';
import { queueRecoveryCapability } from '../src/queue-snapshot.mjs';
import { cronRecoveryCapability } from '../src/cron-snapshot.mjs';
import { operateDispatch } from '../src/admin-dispatch.mjs';
import { writeAtomicFile } from '../src/atomic-file.mjs';
import { seedRouteStores } from './fixtures/route-stores.mjs';
import { fixture as queueFixture } from './fixtures/queue-controller.mjs';
import { fixture as cronFixture } from './fixtures/cron-controller.mjs';
import { policy as nativePolicy } from './fixtures/runtime-policy.mjs';
import { retirementRequest } from './fixtures/route-retirement.mjs';

const durableProfile = () => ({ ...nativePolicy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'] });
const profile = durableProfile(), slots = profile.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
const policy = { installation: runtimePolicyIdentity(profile), slots: slots.map(slot => slot.id) };
const binding = 'b'.repeat(64), snapshot = 'c'.repeat(64);
const refused = error => error.code === 'ROUTE_RESTORATION_REFUSED' && error.cause === undefined;
const uncertain = error => error.code === 'ROUTE_RESTORATION_UNCERTAIN' && error.cause === undefined && !error.message.includes('PRIVATE');
const roles = ['controller', 'authority', 'enrollment'];
const temporary = async (t, name) => { const root = await mkdtemp(join(tmpdir(), name)); t.after(() => rm(root, { recursive: true, force: true })); return root; };

// A real durable source controller, published through the production publisher.
async function source(t) {
  const root = await temporary(t, 'fogd-restore-source-'), dir = join(root, 'private'), authority = join(root, 'authority');
  await mkdir(authority, { mode: 0o755 });
  const path = join(authority, 'routes.json'), owners = {};
  const backend = {
    owner: async slot => owners[slot.id] || null, hasDeployment: async () => false, assertUnclaimed: async () => {},
    async claim(slot, app) { owners[slot.id] = { app }; }, publish: async () => randomUUID(),
    ready: async () => {}, applicationReady: async () => {}, migrate: async () => {}, applied: async () => [],
  };
  await seedRouteStores(dir, { path, policy, verifyRuntime: async () => {} });
  const c = new Controller({ dir, slots, backend, routeAuthority: { path, policy, verifyRuntime: async () => {} }, reportStorageFailure: () => {} }); await c.init();
  async function approve(app) {
    const id = randomUUID(), artifact = c.artifact(id); await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, 'index.js'), `// ${id}\nexport default {fetch(){return new Response('ok')}}`);
    await writeFile(join(artifact, 'wrangler.json'), JSON.stringify({ name: app, main: 'index.js', d1_databases: [] }));
    const value = { id, app, digest: await artifactDigest(artifact), resources: { script: app, d1: [], r2: [], durable: { bindings: [] } }, migrations: [], requiredSecrets: [], status: 'pending', step: 'submitted' };
    c.state.deployments[id] = value; await c.save(); await c.mutate(id, value.digest, 'approve'); return value;
  }
  const pair = async () => ({ state: JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')), authority: await readRouteRecord(path, policy) });
  return { c, dir, owners, approve, pair };
}
// Ordinary fresh enrollment of separate target stores, exactly as production does.
async function target(t) {
  const root = await temporary(t, 'fogd-restore-target-'), paths = Object.fromEntries(roles.map(role => [role, join(root, role)]));
  for (const path of Object.values(paths)) await mkdir(path, { mode: 0o755 });
  const grant = await initializeFreshRouteStores({ profile: durableProfile(), binding }, paths);
  return { root, paths, grant, files: () => listing(paths) };
}
async function listing(paths) {
  const result = {};
  for (const role of roles) for (const name of (await readdir(paths[role])).sort()) result[`${role}/${name}`] = await readFile(join(paths[role], name), 'utf8');
  return result;
}
const request = (state, authority, change = {}) => ({ profile: durableProfile(), sourceProfile: durableProfile(), source: { state, authority }, snapshot, binding, domain: 'localhost', ...change });
async function restart(paths, owners = {}) {
  const c = new Controller({ dir: paths.controller, slots, backend: { owner: async slot => owners[slot.id] || null, hasDeployment: async () => false },
    routeAuthority: { path: join(paths.authority, 'routes.json'), policy, verifyRuntime: async () => {} }, reportStorageFailure: () => {} });
  await c.init(); return c;
}

test('an empty source restores as a settled withheld revision one and starts', async t => {
  const s = await source(t), { state, authority } = await s.pair(), d = await target(t);
  const receipt = await restoreEnrolledRouteStores(request(state, authority), d.paths);
  const record = await readRouteRecord(join(d.paths.authority, 'routes.json'), policy);
  assert.deepEqual(receipt, { id: d.grant.id, installation: policy.installation, binding, snapshot, revision: '1', sha256: record.digest });
  assert.deepEqual(record.record, { schema: 1, installation: policy.installation, revision: '1', routes: [] });
  const saved = JSON.parse(await readFile(join(d.paths.controller, 'state.json'), 'utf8'));
  assert.deepEqual(saved.routeAuthority, { schema: 1, installation: policy.installation, holds: {}, settled: { revision: '1', digest: record.digest }, pending: null });
  assert.notDeepEqual(saved.routeEnrollment, state.routeEnrollment);
  assert.deepEqual(JSON.parse(await readFile(join(d.paths.enrollment, 'route-restoration.spent.json'), 'utf8')),
    { schema: 1, id: d.grant.id, installation: policy.installation, binding, snapshot });
  const c = await restart(d.paths); assert.equal(c.routingStartupComplete, true);
});

test('active and paused sources restore withheld behind exact holds and the target controller can resume', async t => {
  const s = await source(t), alpha = await s.approve('alpha'), beta = await s.approve('beta');
  await s.c.decideRoute('beta', 'pause', { deployment: beta.id, digest: beta.digest });
  const { state, authority } = await s.pair(), d = await target(t);
  assert.deepEqual(authority.record.routes.map(route => route.state), ['active', 'withheld']);
  const projected = prepareRouteRestoration(request(state, authority));
  assert.deepEqual(projected.record.routes, authority.record.routes.map(({ host, slot }) => ({ host, state: 'withheld', slot })));
  assert.deepEqual(projected.state.routeAuthority.holds, { alpha: { id: alpha.id, digest: alpha.digest } });
  assert.deepEqual(Object.values(projected.state.apps).map(app => app.route), ['paused', 'paused']);
  assert.deepEqual(projected.state.deployments, state.deployments);
  assert.equal(Object.hasOwn(projected.state, 'routeEnrollment'), false);
  // The coordinator restores controller data files beside the target state.json.
  await cp(join(s.dir, 'artifacts'), join(d.paths.controller, 'artifacts'), { recursive: true });
  await restoreEnrolledRouteStores(request(state, authority), d.paths);
  const c = await restart(d.paths, s.owners);
  assert.equal(c.routingStartupComplete, true);
  assert.equal(c.state.apps.alpha.quarantined, undefined);
  await c.decideRoute('alpha', 'resume', { deployment: alpha.id, digest: alpha.digest });
  assert.equal((await readRouteRecord(join(d.paths.authority, 'routes.json'), policy)).record.routes[0].state, 'active');
});

test('replay, partial restoration markers and reused grants refuse without touching stores', async t => {
  const s = await source(t); await s.approve('alpha');
  const { state, authority } = await s.pair(), input = request(state, authority);
  const done = await target(t); await restoreEnrolledRouteStores(input, done.paths);
  let before = await done.files();
  await assert.rejects(restoreEnrolledRouteStores(input, done.paths), refused);
  assert.deepEqual(await done.files(), before);
  const partial = await target(t); await writeFile(join(partial.paths.enrollment, 'route-restoration.spent.json'), '', { mode: 0o600 });
  before = await partial.files();
  await assert.rejects(restoreEnrolledRouteStores(input, partial.paths), refused);
  assert.deepEqual(await partial.files(), before);
  const reused = await target(t), other = await target(t);
  for (const name of ['route-enrollment.json', 'route-enrollment.spent.json']) await cp(join(other.paths.enrollment, name), join(reused.paths.enrollment, name));
  before = await reused.files();
  await assert.rejects(restoreEnrolledRouteStores(input, reused.paths), refused);
  assert.deepEqual(await reused.files(), before);
  const unspent = await target(t); await rm(join(unspent.paths.enrollment, 'route-enrollment.spent.json'));
  await assert.rejects(restoreEnrolledRouteStores(input, unspent.paths), refused);
  assert.deepEqual(await readdir(unspent.paths.enrollment), ['route-enrollment.json']);
});

for (const [name, change] of [
  ['copied source state', (d, s) => cp(join(s.dir, 'state.json'), join(d.paths.controller, 'state.json'))],
  ['an extra private key', async d => { const path = join(d.paths.controller, 'state.json'), value = JSON.parse(await readFile(path, 'utf8')); value.extra = true; await writeFile(path, JSON.stringify(value)); }],
  ['a modified private journal', async d => { const path = join(d.paths.controller, 'state.json'), value = JSON.parse(await readFile(path, 'utf8')); value.routeAuthority.holds.alpha = { id: randomUUID(), digest: 'e'.repeat(64) }; await writeFile(path, JSON.stringify(value)); }],
  ['an extra authority file', d => writeFile(join(d.paths.authority, 'other.json'), '{}')],
  ['a later public record', d => writeRouteRecord(join(d.paths.authority, 'routes.json'), { schema: 1, installation: policy.installation, revision: '1', routes: [] }, policy)],
  ['a missing private state', d => rm(join(d.paths.controller, 'state.json'))],
]) test(`${name} in the destination refuses before any write`, async t => {
  const s = await source(t); await s.approve('alpha');
  const { state, authority } = await s.pair(), d = await target(t); await change(d, s);
  const before = await d.files();
  await assert.rejects(restoreEnrolledRouteStores(request(state, authority), d.paths), refused);
  assert.deepEqual(await d.files(), before);
});

for (const [name, change] of [
  ['a foreign target profile', input => { input.profile.bucket = 'other-bucket'; }],
  ['a different source storage', input => { input.sourceProfile.storage.region = 'eu-west-1'; }],
  ['a legacy source profile', input => { input.sourceProfile = nativePolicy(); }],
  ['a copied source binding', input => { input.binding = 'a'.repeat(64); }],
  ['a short binding', input => { input.binding = 'b'.repeat(63); }],
  ['an invalid snapshot', input => { input.snapshot = 'C'.repeat(64); }],
  ['a wrong domain', input => { input.domain = 'example.test'; }],
  ['serialized paths', input => { input.controller = '/tmp'; }],
  ['an extra authority key', input => { input.source.authority.extra = true; }],
  ['a pending source publication', input => { input.source.state.routeAuthority.pending = { id: 'withhold:9', kind: 'withhold', app: 'alpha', approval: null, previous: null, record: {}, digest: 'f'.repeat(64) }; }],
  ['a stale source journal', input => { input.source.state.routeAuthority.settled.digest = 'f'.repeat(64); }],
]) test(`${name} refuses before spending`, async t => {
  const s = await source(t); await s.approve('alpha');
  const { state, authority } = await s.pair(), d = await target(t), input = request(state, authority); change(input);
  const before = await d.files();
  await assert.rejects(restoreEnrolledRouteStores(input, d.paths), refused);
  assert.deepEqual(await d.files(), before);
});

test('a network-only profile difference is accepted', async t => {
  const s = await source(t); await s.approve('alpha');
  const { state, authority } = await s.pair(), input = request(state, authority);
  input.sourceProfile.networks = { control: '10.1.0.0/24', 'fleet-1': '10.2.0.0/24', 'fleet-2': '10.3.0.0/24' };
  assert.equal(prepareRouteRestoration(input).record.revision, '1');
});

for (const when of ['before', 'after']) test(`a public write fault ${when} persistence retains the spent marker, stays fenced and refuses replay`, async t => {
  const s = await source(t); await s.approve('alpha');
  const { state, authority } = await s.pair(), d = await target(t), input = request(state, authority);
  const writePublic = async (path, record, value) => {
    if (when === 'after') await writeRouteRecord(path, record, value);
    throw new Error('PRIVATE interrupted');
  };
  await assert.rejects(restoreEnrolledRouteStores(input, { ...d.paths, writePublic }), uncertain);
  assert.deepEqual((await readdir(d.paths.enrollment)).sort(), ['route-enrollment.json', 'route-enrollment.spent.json', 'route-restoration.spent.json']);
  assert.equal(JSON.parse(await readFile(join(d.paths.controller, 'state.json'), 'utf8')).routeAuthority.settled.revision, '1');
  assert.equal((await readRouteRecord(join(d.paths.authority, 'routes.json'), policy)).record.revision, when === 'after' ? '1' : '0');
  if (when === 'before') await assert.rejects(restart(d.paths, s.owners), { code: 'ROUTE_PUBLICATION_UNCERTAIN' });
  const before = await d.files();
  await assert.rejects(restoreEnrolledRouteStores(input, d.paths), refused);
  assert.deepEqual(await d.files(), before);
});

// Durable queue source: real activation, real snapshot receipt through admin delivery.
async function queueSource(t, clock = Date.now) {
  const root = await temporary(t, 'fogd-restore-queue-'), dir = join(root, 'authority'); await mkdir(dir, { mode: 0o755 });
  const routeAuthority = { path: join(dir, 'routes.json'), policy, verifyRuntime: async () => {} };
  const f = await queueFixture(t, { slots, routeAuthority, clock }), value = await f.request();
  await f.c.mutate(value.id, value.digest, 'approve');
  const at = clock() - 1000, observation = { paused: true, stored: 1, backlogCount: 1, backlogBytes: 10, oldestMessageTimestamp: at };
  f.backend.queues.snapshot = async () => structuredClone(observation);
  const pair = async () => ({ state: JSON.parse(await readFile(join(f.c.dir, 'state.json'), 'utf8')), authority: await readRouteRecord(routeAuthority.path, policy) });
  return { f, value, pair, snapshot: () => operateDelivery(f.c, 'imports', 'snapshot', { deployment: value.id, digest: value.digest }) };
}
test('a queue receipt becomes a pending recovery and its snapshot field is consumed', async t => {
  const q = await queueSource(t); await q.snapshot();
  const { state, authority } = await q.pair(), d = await target(t);
  await restoreEnrolledRouteStores(request(state, authority), d.paths);
  const saved = JSON.parse(await readFile(join(d.paths.controller, 'state.json'), 'utf8')), app = saved.apps.imports;
  assert.ok(saved.requirements.includes(queueRecoveryCapability));
  assert.equal(app.queueSnapshot, undefined); assert.equal(app.route, 'paused');
  assert.match(app.queueRecovery.id, /^[a-f0-9-]{36}$/);
  assert.deepEqual({ ...app.queueRecovery, id: null }, { id: null, status: 'pending', snapshot, prepared: state.apps.imports.queueSnapshot, previous: null });
  assert.deepEqual(saved.routeAuthority.holds, { imports: { id: q.value.id, digest: q.value.digest } });
});
test('queue lifecycle without a receipt or with an unacknowledged recovery refuses', async t => {
  const q = await queueSource(t), missing = await q.pair(), d = await target(t);
  await assert.rejects(restoreEnrolledRouteStores(request(missing.state, missing.authority), d.paths), refused);
  await q.snapshot(); const pending = await q.pair();
  pending.state.requirements.push(queueRecoveryCapability);
  pending.state.apps.imports.queueRecovery = { id: randomUUID(), status: 'pending', snapshot, prepared: pending.state.apps.imports.queueSnapshot };
  assert.throws(() => prepareRouteRestoration(request(pending.state, pending.authority)), refused);
  const old = await queueSource(t, () => Date.now() - 5 * 24 * 60 * 60 * 1000); await old.snapshot();
  const expired = await old.pair(); assert.ok(expired.state.apps.imports.queueSnapshot.expiresAt < Date.now());
  assert.throws(() => prepareRouteRestoration(request(expired.state, expired.authority)), refused);
  assert.deepEqual((await readdir(d.paths.enrollment)).sort(), ['route-enrollment.json', 'route-enrollment.spent.json']);
});

async function cronSource(t) {
  const root = await temporary(t, 'fogd-restore-cron-'), dir = join(root, 'authority'); await mkdir(dir, { mode: 0o755 });
  const routeAuthority = { path: join(dir, 'routes.json'), policy, verifyRuntime: async () => {} };
  const f = await cronFixture(t, { slots, routeAuthority }), value = await f.request();
  await f.c.mutate(value.id, value.digest, 'approve');
  await operateDispatch(f.c, 'refresh', 'snapshot', { deployment: value.id, digest: value.digest });
  const state = JSON.parse(await readFile(join(f.dir, 'state.json'))), authority = await readRouteRecord(routeAuthority.path, policy);
  return { f, value, state, authority };
}

test('scheduled snapshot restoration holds HTTP and creates pending recovery without resuming dispatch', async t => {
  const { f, value, state, authority } = await cronSource(t), d = await target(t);
  const runtimeBefore = await f.runtime();
  await restoreEnrolledRouteStores(request(state, authority), d.paths);
  const saved = JSON.parse(await readFile(join(d.paths.controller, 'state.json'))), app = saved.apps.refresh;
  assert.ok(saved.requirements.includes(cronRecoveryCapability)); assert.equal(app.cronSnapshot, undefined);
  assert.deepEqual({ ...app.cronRecovery, id: null }, { id: null, status: 'pending', snapshot, prepared: state.apps.refresh.cronSnapshot, previous: null });
  assert.equal(app.route, 'paused'); assert.equal(app.dispatch.desired, 'paused');
  assert.deepEqual(saved.routeAuthority.holds.refresh, { id: value.id, digest: value.digest });
  assert.deepEqual(await f.runtime(), runtimeBefore);
  const pending = structuredClone(state); pending.requirements.push(cronRecoveryCapability);
  pending.apps.refresh.cronRecovery = { id: randomUUID(), status: 'pending', snapshot, prepared: state.apps.refresh.cronSnapshot };
  assert.throws(() => prepareRouteRestoration(request(pending, authority)), refused);
});

for (const when of ['before', 'after']) test(`private persistence failure ${when} write retains the restoration marker and refuses replay`, async t => {
  const s = await source(t); await s.approve('alpha');
  const { state, authority } = await s.pair(), d = await target(t), input = request(state, authority);
  await assert.rejects(restoreEnrolledRouteStores(input, { ...d.paths, writePrivate: async (path, text, options) => {
    assert.equal(JSON.parse(await readFile(join(d.paths.enrollment, 'route-restoration.spent.json'))).snapshot, snapshot);
    if (when === 'after') await writeAtomicFile(path, text, options);
    throw new Error('PRIVATE injected persistence failure');
  }, writePublic: async () => assert.fail('No public write after private failure') }), uncertain);
  const observed = await readRouteRecord(join(d.paths.authority, 'routes.json'), policy);
  assert.equal(observed.record.revision, '0');
  const saved = JSON.parse(await readFile(join(d.paths.controller, 'state.json')));
  assert.equal(saved.routeAuthority.settled.revision, when === 'after' ? '1' : '0');
  const before = await d.files(); await assert.rejects(restoreEnrolledRouteStores(input, d.paths), refused);
  assert.deepEqual(await d.files(), before);
});

const entrypoint = fileURLToPath(new URL('../src/import-restored-routes.mjs', import.meta.url));
for (const [name, input] of [
  ['oversized', Buffer.alloc(16 * 1024 * 1024 + 1, 0x20)],
  ['invalid UTF-8', Buffer.from([0xff])],
  ['BOM-prefixed', Buffer.from('﻿{}')],
  ['path-carrying', Buffer.from(JSON.stringify({ ...request({}, null), controller: '/tmp' }))],
]) test(`entrypoint exits nonzero with no receipt for ${name} input`, () => {
  const result = spawnSync(process.execPath, [entrypoint], { input, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.match(result.stderr, /^Route restoration failed( \(ROUTE_[A-Z_]+\))?; keep ingress stopped and retain all stores\n$/);
});

// The fixture's original profile matches these controller fleets. Only the app,
// approval and source pair differ; the replacement identity remains explicit.
function backgroundRetirement(pair, app, value) {
  const input = retirementRequest();
  input.source = pair;
  Object.assign(input.retirement, { app, digest: value.digest });
  Object.assign(input.retirement.evidence, { app, digest: value.digest });
  return input;
}

test('durable queue retirement requires stopped-work acknowledgment and retains the original snapshot audit', async t => {
  const q = await queueSource(t); await q.snapshot();
  const pair = await q.pair(), input = backgroundRetirement(pair, 'imports', q.value);
  assert.throws(() => prepareRetiredRouteRestoration(input), { code: 'ROUTE_RETIREMENT_REFUSED' });
  input.retirement.stopQueuedWork = true;
  const projected = prepareRetiredRouteRestoration(input), app = projected.state.apps.imports;
  assert.deepEqual(projected.record.routes, []);
  assert.equal(app.route, 'retired'); assert.equal(app.delivery, undefined); assert.equal(app.queueRecovery, undefined);
  assert.deepEqual(app.retirement.snapshot, { sha256: snapshot });
  assert.deepEqual(app.retirement.queue.prepared, pair.state.apps.imports.queueSnapshot);
  assert.equal(app.retirement.queue.stopQueuedWork, true);
  assert.equal(pair.state.apps.imports.route, 'active');
});

test('durable scheduled retirement requires stopped-work acknowledgment and retains dispatch history without executing work', async t => {
  const { f, value, state, authority } = await cronSource(t), before = await f.runtime();
  const input = backgroundRetirement({ state, authority }, 'refresh', value);
  assert.throws(() => prepareRetiredRouteRestoration(input), { code: 'ROUTE_RETIREMENT_REFUSED' });
  input.retirement.stopScheduledWork = true;
  const projected = prepareRetiredRouteRestoration(input), app = projected.state.apps.refresh;
  assert.deepEqual(projected.record.routes, []);
  assert.equal(app.route, 'retired'); assert.equal(app.dispatch, undefined); assert.equal(app.cronRecovery, undefined);
  assert.deepEqual(app.retirement.snapshot, { sha256: snapshot });
  assert.deepEqual(app.retirement.cron.prepared, state.apps.refresh.cronSnapshot);
  assert.equal(app.retirement.cron.stopScheduledWork, true);
  assert.deepEqual(await f.runtime(), before);
});
