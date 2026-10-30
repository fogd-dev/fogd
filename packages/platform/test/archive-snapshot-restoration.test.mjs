import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareAppArchiveRoutes, prepareAppArchiveRestoreRoutes, validateAppArchiveSnapshot } from '../src/app-archive-routes.mjs';
import { prepareSnapshotRouteRestoration, restoreEnrolledRouteStores } from '../src/route-restoration.mjs';
import { initializeFreshRouteStores } from '../src/fresh-route-enrollment.mjs';
import { readRouteRecord } from '../src/route-record-store.mjs';
import { runtimePolicyIdentity } from '../src/runtime-policy.mjs';
import { retirementRequest, retirementId, alphaId, alphaDigest, betaId, betaDigest } from './fixtures/route-retirement.mjs';

function fixture() {
  const { sourceProfile, profile, source, snapshot, binding, domain } = retirementRequest();
  for (const policy of [sourceProfile, profile]) Object.assign(policy, { schema: 4, controllerArgs: ['packages/platform/src/main-archive.mjs'] });
  profile.fleets[0].prefix = `archive-generations/${retirementId}`;
  source.state.artifactPins = { schema: 1, releases: { [alphaId]: alphaDigest } };
  const archived = prepareAppArchiveRoutes({ profile, sourceProfile, source, snapshot, binding, domain,
    archive: { app: 'alpha', digest: alphaDigest, id: retirementId, at: '2026-10-30T02:00:00.000Z' } });
  return { profile, original: sourceProfile, source: { state: archived.state, authority: { record: archived.record, digest: archived.state.routeAuthority.settled.digest } }, snapshot, binding, domain };
}
function whole(f) { return { profile: f.profile, sourceProfile: f.profile, source: f.source, snapshot: 'd'.repeat(64), binding: f.binding, domain: f.domain }; }

test('whole snapshot restore retains detached archives, pins and names while withholding live peers', () => {
  const f = fixture(), input = whole(f), before = structuredClone(input), projected = prepareSnapshotRouteRestoration(input);
  assert.deepEqual(projected.state.appArchives, f.source.state.appArchives);
  assert.deepEqual(projected.state.apps.alpha, f.source.state.apps.alpha);
  assert.deepEqual(projected.state.artifactPins, f.source.state.artifactPins);
  assert.deepEqual(projected.state.deployments, f.source.state.deployments);
  assert.equal(projected.state.apps.alpha.route, 'archived');
  assert.equal(projected.state.apps.beta.route, 'paused');
  assert.deepEqual(projected.record.routes, [{ host: 'beta.localhost', state: 'withheld', slot: 'slot-2' }]);
  assert.deepEqual(projected.state.routeAuthority.holds, { beta: { id: betaId, digest: betaDigest } });
  validateAppArchiveSnapshot(projected.state, { record: projected.record, digest: projected.state.routeAuthority.settled.digest }, f.profile);
  assert.deepEqual(input, before);
  projected.state.apps.alpha.active = betaId;
  assert.equal(input.source.state.apps.alpha.active, alphaId);
});

test('whole snapshot restore preserves an outstanding app approval gate without replacing its snapshot or identity', () => {
  const f = fixture(), restored = prepareAppArchiveRestoreRoutes({ profile: f.original, sourceProfile: f.profile, source: f.source,
    snapshot: 'e'.repeat(64), binding: f.binding, domain: f.domain,
    restore: { archive: retirementId, expectedIdentity: f.source.state.appArchives.records[retirementId].identity, slot: 'slot-1' } });
  const input = { ...whole(f), profile: f.original, sourceProfile: f.original, source: { state: restored.state, authority: { record: restored.record, digest: restored.state.routeAuthority.settled.digest } } };
  const projected = prepareSnapshotRouteRestoration(input);
  assert.deepEqual(projected.state.appArchives, restored.state.appArchives);
  assert.deepEqual(projected.state.apps.alpha.archiveRecovery, restored.state.apps.alpha.archiveRecovery);
  assert.equal(projected.state.appArchives.records[retirementId].restoration.snapshot, 'e'.repeat(64));
  assert.ok(projected.record.routes.every(route => route.state === 'withheld'));
});

for (const [name, change] of [
  ['unknown source fields', input => { input.source.extra = true; }],
  ['changed identity', input => { input.source.state.appArchives.records[retirementId].digest = 'a'.repeat(64); }],
  ['missing capability', input => { input.source.state.requirements = input.source.state.requirements.filter(cap => cap !== 'fogd-app-archive-v1'); }],
  ['foreign target family', input => { input.profile = { ...input.profile, family: 'foreign-family' }; }],
  ['ordinary durable mode', input => { for (const key of ['profile', 'sourceProfile']) input[key] = { ...input[key], schema: 3, controllerArgs: ['packages/platform/src/main-durable.mjs'] }; }],
  ['unmarked archive in ordinary mode', input => { for (const key of ['profile', 'sourceProfile']) input[key] = { ...input[key], schema: 3, controllerArgs: ['packages/platform/src/main-durable.mjs'] }; input.source.state.requirements = input.source.state.requirements.filter(cap => cap !== 'fogd-app-archive-v1'); }],
]) test(`whole snapshot restoration refuses ${name}`, () => {
  const input = whole(fixture()); change(input);
  assert.throws(() => prepareSnapshotRouteRestoration(input));
});

test('fixed whole snapshot helper spends only fresh enrollment and reads back archive state with physical target bindings', async t => {
  const input = whole(fixture()), root = await mkdtemp(join(tmpdir(), 'fogd-archive-whole-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(['controller', 'authority', 'enrollment'].map(role => [role, join(root, role)]));
  for (const path of Object.values(paths)) await mkdir(path);
  await initializeFreshRouteStores({ profile: input.profile, binding: input.binding }, paths);
  await restoreEnrolledRouteStores(input, paths);
  const saved = JSON.parse(await readFile(join(paths.controller, 'state.json'))), policy = { installation: runtimePolicyIdentity(input.profile), slots: ['slot-1', 'slot-2'] };
  const observed = await readRouteRecord(join(paths.authority, 'routes.json'), policy);
  validateAppArchiveSnapshot(saved, observed, input.profile);
  assert.deepEqual(saved.appArchives, input.source.state.appArchives);
  for (const role of ['controller', 'authority']) {
    const physical = await stat(paths[role], { bigint: true });
    assert.deepEqual(saved.routeEnrollment[role], { path: await realpath(paths[role]), device: String(physical.dev), inode: String(physical.ino) });
  }
  const before = await readFile(join(paths.controller, 'state.json'));
  await assert.rejects(restoreEnrolledRouteStores(input, paths), { code: 'ROUTE_RESTORATION_REFUSED' });
  assert.deepEqual(await readFile(join(paths.controller, 'state.json')), before);
});
