import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareAppArchiveRoutes, prepareAppArchiveRestoreRoutes, validateAppArchiveSnapshot, restoreAppArchiveStores, restoreAppArchiveRecoveryStores } from '../src/app-archive-routes.mjs';
import { initializeFreshRouteStores } from '../src/fresh-route-enrollment.mjs';
import { readRouteRecord, writeRouteRecord, routeRecordDigest } from '../src/route-record-store.mjs';
import { runtimePolicyIdentity } from '../src/runtime-policy.mjs';
import { retirementRequest, retirementId, alphaId, alphaDigest, betaId, betaDigest } from './fixtures/route-retirement.mjs';

function request() {
  const old = retirementRequest(), profile = structuredClone(old.profile);
  profile.fleets[0].prefix = `archive-generations/${retirementId}`;
  return { profile, sourceProfile: old.sourceProfile, source: old.source, snapshot: old.snapshot, binding: old.binding, domain: old.domain,
    archive: { app: 'alpha', digest: alphaDigest, id: retirementId, at: '2026-10-30T02:00:00.000Z' } };
}
function restoration(input, projected) {
  return { profile: input.sourceProfile, sourceProfile: input.profile,
    source: { state: projected.state, authority: { record: projected.record, digest: projected.state.routeAuthority.settled.digest } },
    snapshot: 'd'.repeat(64), binding: 'b'.repeat(64), domain: 'localhost',
    restore: { archive: retirementId, expectedIdentity: projected.state.appArchives.records[retirementId].identity, slot: 'slot-1' } };
}
async function target(t, input) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-app-archive-routes-')); t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { controller: join(root, 'controller'), authority: join(root, 'authority'), enrollment: join(root, 'enrollment') };
  await Promise.all(Object.values(paths).map(path => mkdir(path)));
  await initializeFreshRouteStores({ profile: input.profile, binding: input.binding }, paths);
  return paths;
}
const readState = async paths => JSON.parse(await readFile(join(paths.controller, 'state.json')));
const readAuthority = (paths, input) => readRouteRecord(join(paths.authority, 'routes.json'), { installation: runtimePolicyIdentity(input.profile), slots: ['slot-1', 'slot-2'] });

test('archive routing removes alpha authority and withholds beta behind its exact approval', () => {
  const input = request(), before = structuredClone(input), result = prepareAppArchiveRoutes(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.record.routes, [{ host: 'beta.localhost', state: 'withheld', slot: 'slot-2' }]);
  assert.deepEqual(result.state.routeAuthority.holds, { beta: { id: betaId, digest: betaDigest } });
  assert.equal(result.state.apps.alpha.route, 'archived');
  assert.equal(result.state.apps.alpha.slot, null);
  assert.equal(result.state.apps.beta.route, 'paused');
  assert.equal(result.record.installation, runtimePolicyIdentity(input.profile));
});

test('restoration publishes only withheld authority for the exact archived release', () => {
  const input = request(), archived = prepareAppArchiveRoutes(input), restore = restoration(input, archived), before = structuredClone(restore);
  const result = prepareAppArchiveRestoreRoutes(restore);
  assert.deepEqual(restore, before);
  assert.deepEqual(result.record.routes, [{ host: 'alpha.localhost', state: 'withheld', slot: 'slot-1' }, { host: 'beta.localhost', state: 'withheld', slot: 'slot-2' }]);
  assert.deepEqual(result.state.routeAuthority.holds, { alpha: { id: alphaId, digest: alphaDigest }, beta: { id: betaId, digest: betaDigest } });
  assert.equal(result.state.apps.alpha.archiveRecovery.status, 'pending');
  assert.deepEqual(result.state.apps.beta, archived.state.apps.beta);
});

test('archive store replacement spends fresh enrollment once and validates saved private/public identity', async t => {
  const input = request(), paths = await target(t, input), receipt = await restoreAppArchiveStores(input, paths);
  const state = await readState(paths), authority = await readAuthority(paths, input);
  assert.equal(state.apps.alpha.route, 'archived');
  assert.deepEqual(authority.record.routes, [{ host: 'beta.localhost', state: 'withheld', slot: 'slot-2' }]);
  assert.equal(receipt.sha256, authority.digest);
  assert.equal(receipt.installation, runtimePolicyIdentity(input.profile));
  validateAppArchiveSnapshot(state, authority, input.profile);
  await assert.rejects(restoreAppArchiveStores(input, paths), { code: 'ROUTE_RESTORATION_REFUSED' });
  assert.deepEqual(await readState(paths), state);
});

test('restoring from saved archive stores into another fresh target leaves both apps held', async t => {
  const input = request(), first = await target(t, input); await restoreAppArchiveStores(input, first);
  const restore = restoration(input, { state: await readState(first), record: (await readAuthority(first, input)).record });
  const second = await target(t, restore), receipt = await restoreAppArchiveRecoveryStores(restore, second);
  const state = await readState(second), authority = await readAuthority(second, restore);
  assert.equal(state.apps.alpha.archiveRecovery.status, 'pending');
  assert.equal(state.apps.alpha.route, 'paused');
  assert.equal(state.apps.beta.route, 'paused');
  assert.deepEqual(authority.record.routes, [{ host: 'alpha.localhost', state: 'withheld', slot: 'slot-1' }, { host: 'beta.localhost', state: 'withheld', slot: 'slot-2' }]);
  assert.equal(receipt.sha256, authority.digest);
  validateAppArchiveSnapshot(state, authority, restore.profile);
});

test('changed source authority refuses before spending restoration enrollment', async t => {
  const input = request(), paths = await target(t, input);
  input.source.authority.record.routes[0].digest = '0'.repeat(64);
  const before = await readState(paths);
  await assert.rejects(restoreAppArchiveStores(input, paths), { code: 'ROUTE_RESTORATION_REFUSED' });
  assert.deepEqual(await readState(paths), before);
  assert.deepEqual((await readdir(paths.enrollment)).sort(), ['route-enrollment.json', 'route-enrollment.spent.json']);
});

test('interruption after private archive replacement retains the spent grant and refuses replay', async t => {
  const input = request(), paths = await target(t, input);
  await assert.rejects(restoreAppArchiveStores(input, { ...paths, writePublic: async () => { throw Error('private transport detail'); } }), { code: 'ROUTE_RESTORATION_UNCERTAIN' });
  assert.equal((await readState(paths)).apps.alpha.route, 'archived');
  assert.equal((await readAuthority(paths, input)).record.revision, '0');
  assert.equal(JSON.parse(await readFile(join(paths.enrollment, 'route-restoration.spent.json'))).snapshot, input.snapshot);
  await assert.rejects(restoreAppArchiveStores(input, paths), { code: 'ROUTE_RESTORATION_REFUSED' });
});

test('a lost reply after public archive replacement remains uncertain despite matching stores', async t => {
  const input = request(), paths = await target(t, input);
  const writePublic = async (path, record, policy) => { await writeRouteRecord(path, record, policy); throw Error('lost reply'); };
  await assert.rejects(restoreAppArchiveStores(input, { ...paths, writePublic }), { code: 'ROUTE_RESTORATION_UNCERTAIN' });
  const state = await readState(paths), authority = await readAuthority(paths, input);
  assert.equal(state.routeAuthority.settled.digest, authority.digest);
  await assert.rejects(restoreAppArchiveStores(input, paths), { code: 'ROUTE_RESTORATION_REFUSED' });
});

test('archive snapshot validation refuses authority for a reserved archived name', () => {
  const input = request(), projected = prepareAppArchiveRoutes(input);
  projected.record.routes.unshift({ host: 'alpha.localhost', state: 'withheld', slot: 'slot-1' });
  projected.state.routeAuthority.settled.digest = routeRecordDigest(projected.record, { installation: runtimePolicyIdentity(input.profile), slots: ['slot-1', 'slot-2'] });
  assert.throws(() => validateAppArchiveSnapshot(projected.state, { record: projected.record, digest: projected.state.routeAuthority.settled.digest }, input.profile), { code: 'APP_ARCHIVE_ROUTES_REFUSED' });
});

test('restored archive validation refuses losing its exact approval hold', () => {
  const input = request(), projected = prepareAppArchiveRestoreRoutes(restoration(input, prepareAppArchiveRoutes(input)));
  delete projected.state.routeAuthority.holds.alpha;
  assert.throws(() => validateAppArchiveSnapshot(projected.state, { record: projected.record, digest: projected.state.routeAuthority.settled.digest }, input.sourceProfile), { code: 'APP_ARCHIVE_ROUTES_REFUSED' });
});

const entrypoint = fileURLToPath(new URL('../src/import-app-archive-routes.mjs', import.meta.url));
for (const [name, args, input] of [
  ['unknown operation', ['constructor'], Buffer.from('{}')],
  ['invalid UTF-8', ['archive'], Buffer.from([0xff])],
  ['oversized JSON', ['archive'], Buffer.alloc(16 * 1024 * 1024 + 1, 0x20)],
  ['serialized path override', ['archive'], Buffer.from(JSON.stringify({ ...request(), controller: '/tmp/private-override' }))],
]) test(`fixed archive entrypoint refuses ${name} without a receipt`, () => {
  const result = spawnSync(process.execPath, [entrypoint, ...args], { input, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'App archive route restoration failed; keep ingress stopped and retain all stores\n');
});

test('queued archive routing retains paused backlog metadata without publishing the restored app', async t => {
  const { fixture: queued } = await import('./fixtures/queue-controller.mjs');
  const { operateDelivery } = await import('../src/admin-delivery.mjs');
  const input = request(), root = await mkdtemp(join(tmpdir(), 'fogd-archive-queue-routes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const authorityDirectory = join(root, 'authority'); await mkdir(authorityDirectory, { mode: 0o755 });
  const path = join(authorityDirectory, 'routes.json');
  const slots = input.sourceProfile.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
  const policy = { installation: runtimePolicyIdentity(input.sourceProfile), slots: ['slot-1', 'slot-2'] };
  const f = await queued(t, { slots, routeAuthority: { path, policy, verifyRuntime: async () => {} } }), release = await f.request();
  await f.c.mutate(release.id, release.digest, 'approve');
  f.backend.queues.snapshot = async () => ({ paused: true, stored: 1, backlogCount: 1, backlogBytes: 10, oldestMessageTimestamp: Date.now() - 1000 });
  await operateDelivery(f.c, 'imports', 'snapshot', { deployment: release.id, digest: release.digest });
  input.source = { state: f.c.state, authority: await readRouteRecord(path, policy) };
  input.archive.app = 'imports'; input.archive.digest = release.digest;
  const archived = prepareAppArchiveRoutes(input), restore = restoration(input, archived), result = prepareAppArchiveRestoreRoutes(restore);
  assert.deepEqual(archived.record.routes, []);
  assert.deepEqual(result.record.routes, [{ host: 'imports.localhost', state: 'withheld', slot: 'slot-1' }]);
  assert.equal(result.state.apps.imports.archiveRecovery.status, 'pending');
  assert.equal(result.state.apps.imports.delivery.observed, 'paused');
  assert.deepEqual(result.state.apps.imports.queueSnapshot, f.c.state.apps.imports.queueSnapshot);
});

test('serialized path overrides refuse before spending an otherwise valid fresh archive target', async t => {
  const input = request(), paths = await target(t, input), before = await readState(paths);
  await assert.rejects(restoreAppArchiveStores({ ...input, controller: paths.controller }, paths), { code: 'ROUTE_RESTORATION_REFUSED' });
  assert.deepEqual(await readState(paths), before);
  assert.deepEqual((await readdir(paths.enrollment)).sort(), ['route-enrollment.json', 'route-enrollment.spent.json']);
});
