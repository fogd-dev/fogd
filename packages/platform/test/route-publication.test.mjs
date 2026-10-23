import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RoutePublication, routeAuthorityCapability } from '../src/route-publication.mjs';
import { retireState, validateRetirementState } from '../src/retirement.mjs';
import { retireRouteAuthority } from '../src/route-retirement.mjs';
import { saveJson } from '../src/store.mjs';
import { readRouteRecord, writeRouteRecord, createRouteRecord } from '../src/route-record-store.mjs';

const first = '00000000-0000-4000-8000-000000000001', second = '00000000-0000-4000-8000-000000000002';
const firstDigest = 'b'.repeat(64), secondDigest = 'c'.repeat(64);
const policy = { installation: 'a'.repeat(64), slots: ['slot-1', 'slot-2'] };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-route-publication-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const publicDirectory = join(dir, 'authority'); await mkdir(publicDirectory); await chmod(publicDirectory, 0o755);
  const path = join(publicDirectory, 'routes.json'), privatePath = join(dir, 'private.json');
  let state = { apps: {}, deployments: {} }, privateFault = null, publicFault = null;
  const privateWrite = async () => {
    const fault = privateFault; privateFault = null;
    if (fault === 'before') throw new Error('Private write failed');
    await saveJson(privatePath, state);
    if (fault === 'after') throw new Error('Private result lost');
  };
  const publicWrite = async (file, value) => {
    const fault = publicFault; publicFault = null;
    if (fault === 'before') throw new Error('Public write failed');
    await writeRouteRecord(file, value, policy);
    if (fault === 'after') throw new Error('Public result lost');
  };
  const instance = () => new RoutePublication({ state, path, policy, domain: 'localhost', savePrivate: privateWrite, writePublic: publicWrite });
  let publication = instance();
  return { path, privatePath, state: () => state, publication: () => publication,
    public: async () => JSON.parse(await readFile(path)), private: async () => JSON.parse(await readFile(privatePath)),
    failPrivate: fault => { privateFault = fault; }, failPublic: fault => { publicFault = fault; },
    async reload() { state = JSON.parse(await readFile(privatePath)); publication = instance(); return publication; },
    begin(id = first, digest = firstDigest) {
      state.apps.alpha ||= { slot: 'slot-1', active: null }; state.apps.alpha.route = 'paused';
      state.deployments[id] = { id, app: 'alpha', digest, status: 'activating', step: 'preparing-activation', secretRevision: null };
    },
    complete(id = first) { state.apps.alpha.active = id; state.apps.alpha.route = 'active'; Object.assign(state.deployments[id], { status: 'active', step: 'complete' }); },
  };
}
async function active(t) {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest); f.complete(); await f.publication().activate('alpha'); return f;
}

test('fresh initialization persists one empty authority and a compatibility marker', async t => {
  const f = await fixture(t); await f.publication().initialize();
  assert.deepEqual(await f.public(), { schema: 1, installation: 'a'.repeat(64), revision: '0', routes: [] });
  assert.deepEqual((await f.private()).requirements, [routeAuthorityCapability]); f.publication().assertReady();
});
test('initialization never overwrites existing authority', async t => {
  const f = await fixture(t), original = '{"preserved":"original"}'; await writeFile(f.path, original);
  await assert.rejects(f.publication().initialize(), /uncertain/); assert.equal(await readFile(f.path, 'utf8'), original);
  await assert.rejects(readFile(f.privatePath), { code: 'ENOENT' });
});
test('create-only persistence has exactly one winner under concurrent initialization', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([createRouteRecord(f.path, { schema: 1, installation: policy.installation, revision: '1', routes: [] }, policy), createRouteRecord(f.path, { schema: 1, installation: policy.installation, revision: '2', routes: [] }, policy)]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected')[0].reason.code, 'EEXIST');
  assert.ok(['1', '2'].includes((await f.public()).revision));
});
test('withholding persists intent and blocks readiness before public-write uncertainty', async t => {
  const f = await active(t); f.begin(second, secondDigest); f.failPublic('before');
  await assert.rejects(f.publication().withhold('alpha', second, secondDigest), /uncertain/);
  assert.equal((await f.public()).routes[0].submission, first);
  const saved = await f.private(); assert.equal(saved.routeAuthority.pending.kind, 'withhold');
  assert.deepEqual(saved.routeAuthority.pending.approval, { id: second, digest: secondDigest });
  assert.throws(() => f.publication().assertReady(), /uncertain/);
  await assert.rejects(f.publication().activate('alpha'), /uncertain/);
});
for (const fault of ['before', 'after']) test(`restart completes only withholding after a ${fault}-write fault`, async t => {
  const f = await active(t); f.begin(second, secondDigest); f.failPublic(fault);
  await assert.rejects(f.publication().withhold('alpha', second, secondDigest), /uncertain/);
  const restored = await f.reload(); await restored.resumeWithholding();
  assert.deepEqual((await f.public()).routes, [{ host: 'alpha.localhost', state: 'withheld', slot: 'slot-1' }]);
  assert.equal((await f.private()).routeAuthority.pending, null); restored.assertReady();
  assert.equal(f.state().deployments[second].status, 'activating');
});
test('active permission follows durable completed approval and retains its exact digest', async t => {
  const f = await active(t), saved = await f.private(), published = await f.public();
  assert.equal(saved.apps.alpha.active, first); assert.equal(saved.deployments[first].status, 'active');
  assert.deepEqual(published.routes, [{ host: 'alpha.localhost', state: 'active', slot: 'slot-1', submission: first, digest: firstDigest }]);
  assert.equal(saved.routeAuthority.settled.revision, '2'); assert.equal(saved.routeAuthority.pending, null);
});
test('incomplete approval cannot become public authority', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest);
  f.state().apps.alpha.route = 'active'; f.state().apps.alpha.active = first;
  await assert.rejects(f.publication().activate('alpha'), /completed approval/);
  assert.equal((await f.public()).routes[0].state, 'withheld');
});
test('active publication is not resumed automatically after restart', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest); f.complete(); f.failPublic('before');
  await assert.rejects(f.publication().activate('alpha'), /uncertain/);
  const restored = await f.reload(); await assert.rejects(restored.resumeWithholding(), /uncertain/);
  assert.equal((await f.public()).routes[0].state, 'withheld');
  await assert.rejects(restored.reconcileActive({ intent: 'active:wrong', id: first, digest: firstDigest }, async () => {}), /exact pending/);
  assert.equal((await f.public()).routes[0].state, 'withheld');
  await restored.reconcileActive({ intent: 'active:2', id: first, digest: firstDigest }, async () => {});
  assert.equal((await f.public()).routes[0].submission, first); restored.assertReady();
});
test('failed runtime verification cannot release a pending active publication', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest); f.complete(); f.failPublic('before');
  await assert.rejects(f.publication().activate('alpha'), /uncertain/);
  const restored = await f.reload();
  await assert.rejects(restored.reconcileActive({ intent: 'active:2', id: first, digest: firstDigest }, async () => { throw new Error('Replica unavailable'); }), /uncertain/);
  assert.equal((await f.public()).routes[0].state, 'withheld'); assert.throws(() => restored.assertReady(), /uncertain/);
});
async function privateAcknowledgmentFault(f, when) {
  let writes = 0;
  const publication = new RoutePublication({ state: f.state(), path: f.path, policy, domain: 'localhost', savePrivate: async () => {
    writes++;
    if (writes === 2 && when === 'before') throw new Error('Private acknowledgment write failed');
    await saveJson(f.privatePath, f.state());
    if (writes === 2 && when === 'after') throw new Error('Private acknowledgment result lost');
  } });
  await publication.verifySettled(); return publication;
}
test('committed active permission survives a missing private acknowledgment', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest); f.complete();
  const publication = await privateAcknowledgmentFault(f, 'before');
  await assert.rejects(publication.activate('alpha'), /uncertain/);
  assert.equal((await f.public()).routes[0].submission, first); assert.equal((await f.private()).routeAuthority.pending.kind, 'active');
  const restored = await f.reload(); await restored.reconcileActive({ intent: 'active:2', id: first, digest: firstDigest }, async () => {});
  assert.equal((await f.public()).routes[0].submission, first); assert.equal((await f.private()).routeAuthority.pending, null);
});
test('lost private acknowledgment reloads the already settled active record', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest); f.complete();
  const publication = await privateAcknowledgmentFault(f, 'after');
  await assert.rejects(publication.activate('alpha'), /uncertain/); assert.throws(() => publication.assertReady(), /uncertain/);
  assert.equal((await f.public()).routes[0].submission, first); assert.equal((await f.private()).routeAuthority.pending, null);
  const restored = await f.reload(); await restored.verifySettled(); restored.assertReady();
  assert.equal((await f.public()).revision, '2');
});
test('startup refuses mixed-generation public authority instead of overwriting it', async t => {
  const f = await active(t), value = await f.public(); value.revision = '9'; await saveJson(f.path, value);
  const restored = await f.reload(); await assert.rejects(restored.verifySettled(), /uncertain/);
  assert.equal((await f.public()).revision, '9'); assert.throws(() => restored.assertReady(), /uncertain/);
});
test('missing retained authority refuses rather than recreating it', async t => {
  const f = await active(t); await rm(f.path); const restored = await f.reload();
  await assert.rejects(restored.verifySettled(), /uncertain/); await assert.rejects(readFile(f.path), { code: 'ENOENT' });
});
test('authority reader refuses symbolic links', async t => {
  const f = await active(t), link = f.path + '.link'; await symlink(f.path, link);
  await assert.rejects(readRouteRecord(link, policy));
});

test('new instances cannot authorize backend work before comparing both stores', async t => {
  const f = await active(t), restored = await f.reload();
  assert.throws(() => restored.assertReady(), /uncertain/); await restored.verifySettled(); restored.assertReady();
});
test('failure of private intent persistence cannot publish new permission', async t => {
  const f = await active(t); f.begin(second, secondDigest); f.failPrivate('before');
  await assert.rejects(f.publication().withhold('alpha', second, secondDigest), /uncertain/);
  assert.equal((await f.public()).revision, '2'); assert.equal((await f.public()).routes[0].submission, first);
  assert.equal((await f.private()).routeAuthority.pending, null); assert.throws(() => f.publication().assertReady(), /uncertain/);
});
test('an ambiguous private intent is recoverable only toward withholding', async t => {
  const f = await active(t); f.begin(second, secondDigest); f.failPrivate('after');
  await assert.rejects(f.publication().withhold('alpha', second, secondDigest), /uncertain/);
  assert.equal((await f.public()).routes[0].submission, first);
  const restored = await f.reload(); await restored.resumeWithholding();
  assert.equal((await f.public()).routes[0].state, 'withheld'); assert.equal(f.state().deployments[second].status, 'activating');
});
test('a missing pinned secret revision cannot publish active authority', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest); f.complete();
  delete f.state().deployments[first].secretRevision;
  await assert.rejects(f.publication().activate('alpha'), /exact pinned approval/);
  assert.equal((await f.public()).routes[0].state, 'withheld');
});
for (const patch of [{ quarantined: true }, { uncertain: first }, { claim: { deployment: first } }, { delivery: { hold: first } }, { dispatch: { hold: first } }, { queueRecovery: { status: 'pending' } }, { cronRecovery: { status: 'pending' } }]) test(`unresolved application authority remains withheld: ${JSON.stringify(patch)}`, async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest); f.complete(); Object.assign(f.state().apps.alpha, patch);
  await assert.rejects(f.publication().activate('alpha'), /requested decision/); assert.equal((await f.public()).routes[0].state, 'withheld');
});

test('an active record cannot bypass withholding for its exact approval', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); f.complete();
  await assert.rejects(f.publication().activate('alpha'), /withholding for the exact approval/);
  assert.deepEqual((await f.public()).routes, []); assert.equal((await f.public()).revision, '0');
});
test('withholding for another approval cannot release a newly completed artifact', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest);
  f.begin(second, secondDigest); f.complete(second);
  await assert.rejects(f.publication().activate('alpha'), /withholding for the exact approval/);
  assert.equal((await f.public()).routes[0].state, 'withheld');
});
test('publication for one app cannot release a privately completed peer', async t => {
  const f = await active(t);
  f.state().apps.beta = { slot: 'slot-2', active: second, route: 'active' };
  f.state().deployments[second] = { id: second, app: 'beta', digest: secondDigest, status: 'active', step: 'complete', secretRevision: null };
  f.state().apps.alpha.route = 'paused'; await f.publication().withdraw('alpha');
  assert.deepEqual((await f.public()).routes, [{ host: 'alpha.localhost', state: 'withheld', slot: 'slot-1' }]);
});
test('withdrawal removes permission without granting a release hold', async t => {
  const f = await active(t); f.state().apps.alpha.quarantined = true;
  await f.publication().withdraw('alpha');
  assert.equal((await f.public()).routes[0].state, 'withheld'); assert.deepEqual((await f.private()).routeAuthority.holds, {});
});
for (const revision of [undefined, false, 0, {}, 'private-do-not-echo']) test(`invalid pinned secret revision cannot be serialized away (${typeof revision})`, async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest); f.complete();
  f.state().deployments[first].secretRevision = revision;
  await assert.rejects(f.publication().activate('alpha'), { message: 'Route publication requires the exact pinned approval' });
  assert.equal((await f.public()).routes[0].state, 'withheld');
});
test('a falsely acknowledged public write cannot settle authority', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin();
  const publication = new RoutePublication({ state: f.state(), path: f.path, policy, domain: 'localhost', savePrivate: () => saveJson(f.privatePath, f.state()), writePublic: async () => {} });
  await publication.verifySettled(); await assert.rejects(publication.withhold('alpha', first, firstDigest), /uncertain/);
  assert.equal((await f.public()).revision, '0'); assert.equal((await f.private()).routeAuthority.pending.kind, 'withhold');
  assert.throws(() => publication.assertReady(), /uncertain/);
});

test('unverifiable matching active permission can be explicitly withdrawn after reload', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest); f.complete(); f.failPublic('after');
  await assert.rejects(f.publication().activate('alpha'), /uncertain/);
  const uncertain = await f.reload();
  await assert.rejects(uncertain.reconcileActive({ intent: 'active:2', id: first, digest: firstDigest }, async () => { throw new Error('Native unavailable'); }), /uncertain/);
  assert.equal((await f.public()).routes[0].state, 'active');
  await uncertain.withholdPendingActive({ intent: 'active:2', id: first, digest: firstDigest });
  assert.equal((await f.public()).revision, '3'); assert.equal((await f.public()).routes[0].state, 'withheld');
  assert.equal((await f.private()).routeAuthority.pending, null); assert.deepEqual((await f.private()).routeAuthority.holds, { alpha: { id: first, digest: firstDigest } });
  assert.equal(f.state().apps.alpha.route, 'paused'); uncertain.assertReady();
});
for (const fault of ['before', 'after']) test(`superseding withdrawal resumes after ${fault}-publication failure`, async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest); f.complete(); f.failPublic('after');
  await assert.rejects(f.publication().activate('alpha'), /uncertain/);
  const withdrawing = await f.reload(); f.state().apps.alpha.quarantined = true; f.failPublic(fault);
  await assert.rejects(withdrawing.withholdPendingActive({ intent: 'active:2', id: first, digest: firstDigest }), /uncertain/);
  const restored = await f.reload(); await restored.resumeWithholding();
  assert.equal((await f.public()).revision, '3'); assert.equal((await f.public()).routes[0].state, 'withheld');
  assert.equal((await f.private()).routeAuthority.pending, null); assert.equal(f.state().apps.alpha.quarantined, true);
});
test('pending active intent can be withheld even after quarantine changes its projection', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest); f.complete(); f.failPublic('before');
  await assert.rejects(f.publication().activate('alpha'), /uncertain/);
  const restored = await f.reload(); f.state().apps.alpha.quarantined = true;
  await restored.withholdPendingActive({ intent: 'active:2', id: first, digest: firstDigest });
  assert.equal((await f.public()).revision, '3'); assert.equal((await f.public()).routes[0].state, 'withheld');
});
test('private persistence guard allows its own pending journal write', async t => {
  const f = await fixture(t); let publication;
  publication = new RoutePublication({ state: f.state(), path: f.path, policy, domain: 'localhost', savePrivate: async () => { publication.assertNotFailed(); await saveJson(f.privatePath, f.state()); } });
  await publication.initialize(); publication.assertReady(); assert.equal((await f.public()).revision, '0');
});

function retiredAlpha(state) {
  return retireState(state, 'alpha', firstDigest, { previous: { slot: 'slot-1', prefix: 'alpha-old' }, replacement: { prefix: 'alpha-replacement' } });
}
test('offline retirement removes only its host and permits reuse of the released fleet', async t => {
  const f = await active(t), state = f.state();
  state.apps.beta = { slot: 'slot-2', route: 'paused', active: null };
  state.deployments[second] = { id: second, app: 'beta', digest: secondDigest, status: 'activating', secretRevision: null };
  await f.publication().withhold('beta', second, secondDigest);
  Object.assign(state.apps.beta, { route: 'active', active: second }); Object.assign(state.deployments[second], { status: 'active', step: 'complete' });
  await f.publication().activate('beta');
  await f.publication().withhold('alpha', first, firstDigest);
  const targetPolicy = { ...policy, installation: 'd'.repeat(64) }, original = await readRouteRecord(f.path, policy);
  const transformed = retireRouteAuthority(retiredAlpha(state), original, { app: 'alpha', domain: 'localhost', sourcePolicy: policy, targetPolicy });
  assert.deepEqual(transformed.record.routes, [{ host: 'beta.localhost', state: 'active', slot: 'slot-2', submission: second, digest: secondDigest }]);
  assert.equal(original.record.routes.length, 2); assert.equal(state.routeAuthority.installation, 'a'.repeat(64));
  const path = f.path + '.retired', privatePath = f.privatePath + '.retired'; await writeRouteRecord(path, transformed.record, targetPolicy);
  const third = '00000000-0000-4000-8000-000000000003', thirdDigest = 'e'.repeat(64);
  transformed.state.apps.gamma = { slot: 'slot-1', route: 'paused', active: null };
  transformed.state.deployments[third] = { id: third, app: 'gamma', digest: thirdDigest, status: 'activating', secretRevision: null };
  const publication = new RoutePublication({ state: transformed.state, path, policy: targetPolicy, domain: 'localhost', savePrivate: () => saveJson(privatePath, transformed.state) });
  await publication.verifySettled(); await publication.withhold('gamma', third, thirdDigest);
  assert.deepEqual(JSON.parse(await readFile(path)).routes, [{ host: 'beta.localhost', state: 'active', slot: 'slot-2', submission: second, digest: secondDigest }, { host: 'gamma.localhost', state: 'withheld', slot: 'slot-1' }]);
  assert.equal(transformed.state.apps.alpha.retirement.digest, firstDigest);
  assert.equal(Object.hasOwn(transformed.state.routeAuthority.holds, 'alpha'), false);
});
test('offline removal refuses an application without the exact retirement tombstone', async t => {
  const f = await active(t), observed = await readRouteRecord(f.path, policy);
  assert.throws(() => retireRouteAuthority(f.state(), observed, { app: 'alpha', domain: 'localhost', sourcePolicy: policy, targetPolicy: policy }), /exact retired application/);
  assert.equal((await f.public()).routes[0].state, 'active');
});
test('offline removal refuses an unresolved publication', async t => {
  const f = await active(t); f.failPublic('before');
  await assert.rejects(f.publication().withdraw('alpha'), /uncertain/);
  const state = retiredAlpha(f.state()), observed = await readRouteRecord(f.path, policy);
  assert.throws(() => retireRouteAuthority(state, observed, { app: 'alpha', domain: 'localhost', sourcePolicy: policy, targetPolicy: policy }), /settled matching/);
  assert.equal((await f.public()).routes[0].state, 'active');
});

test('resume verifies the exact completed release before publishing it again', async t => {
  const f = await active(t); await f.publication().withdraw('alpha');
  let verified;
  await f.publication().resume('alpha', { id: first, digest: firstDigest }, async (app, selected) => {
    assert.equal((await f.public()).routes[0].state, 'withheld');
    verified = { app, ...selected };
  });
  assert.deepEqual(verified, { app: 'alpha', id: first, digest: firstDigest });
  assert.deepEqual((await f.public()).routes, [{ host: 'alpha.localhost', state: 'active', slot: 'slot-1', submission: first, digest: firstDigest }]);
  assert.equal((await f.private()).apps.alpha.route, 'active');
});
test('failed resume verification retains withholding and permits an explicit retry', async t => {
  const f = await active(t); await f.publication().withdraw('alpha');
  await assert.rejects(f.publication().resume('alpha', { id: first, digest: firstDigest }, async () => { throw new Error('Not ready'); }), /uncertain/);
  assert.equal((await f.public()).routes[0].state, 'withheld');
  assert.equal((await f.private()).apps.alpha.route, 'paused');
  await f.publication().resume('alpha', { id: first, digest: firstDigest }, async () => {});
  assert.equal((await f.public()).routes[0].submission, first);
});
test('resume cannot override quarantine or select a different release', async t => {
  const f = await active(t); await f.publication().withdraw('alpha');
  await assert.rejects(f.publication().resume('alpha', { id: second, digest: secondDigest }, async () => {}), /exact pinned approval/);
  f.state().apps.alpha.quarantined = true;
  await assert.rejects(f.publication().resume('alpha', { id: first, digest: firstDigest }, async () => {}), /controls withhold/);
  assert.equal((await f.public()).routes[0].state, 'withheld');
  assert.equal((await f.public()).revision, '3');
});
test('fresh initialization preserves valid authority for a foreign installation', async t => {
  const f = await fixture(t), foreign = { ...policy, installation: 'f'.repeat(64) };
  const record = { schema: 1, installation: foreign.installation, revision: '0', routes: [] };
  await writeRouteRecord(f.path, record, foreign);
  await assert.rejects(f.publication().initialize(), /uncertain/);
  assert.deepEqual(await f.public(), record);
  await assert.rejects(readFile(f.privatePath), { code: 'ENOENT' });
});
for (const field of ['previous', 'record']) test(`restart refuses a changed pending ${field} without overwriting public authority`, async t => {
  const f = await active(t); f.begin(second, secondDigest); f.failPublic('before');
  await assert.rejects(f.publication().withhold('alpha', second, secondDigest), /uncertain/);
  const state = await f.private(); state.routeAuthority.pending[field].revision = '9';
  await saveJson(f.privatePath, state);
  const restored = await f.reload();
  await assert.rejects(restored.resumeWithholding(), /uncertain/);
  assert.equal((await f.public()).revision, '2');
  assert.equal((await f.public()).routes[0].submission, first);
});
test('malformed private pending metadata refuses construction', async t => {
  const f = await active(t), state = await f.private();
  state.routeAuthority.pending = { kind: 'withhold' }; await saveJson(f.privatePath, state);
  await assert.rejects(f.reload(), /uncertain/);
  assert.equal((await f.public()).revision, '2');
});

test('withholding an approved release does not depend on an earlier desired-route mutation', async t => {
  const f = await active(t);
  await f.publication().withhold('alpha', first, firstDigest);
  assert.deepEqual((await f.public()).routes, [{ host: 'alpha.localhost', state: 'withheld', slot: 'slot-1' }]);
  assert.equal((await f.private()).apps.alpha.route, 'paused');
  assert.deepEqual((await f.private()).routeAuthority.holds, { alpha: { id: first, digest: firstDigest } });
});

test('resume refuses to erase a different approval hold after a failed activation', async t => {
  const f = await active(t); f.begin(second, secondDigest); await f.publication().withhold('alpha', second, secondDigest);
  f.state().deployments[second].status = 'failed';
  await assert.rejects(f.publication().resume('alpha', { id: first, digest: firstDigest }, async () => {}), /different approval/);
  assert.equal((await f.public()).routes[0].state, 'withheld');
  assert.deepEqual((await f.private()).routeAuthority.holds.alpha, { id: second, digest: secondDigest });
});
test('withdrawal retains a failed approval hold so pause cannot authorize the old release', async t => {
  const f = await active(t); f.begin(second, secondDigest); await f.publication().withhold('alpha', second, secondDigest);
  f.state().deployments[second].status = 'failed'; await f.publication().withdraw('alpha');
  await assert.rejects(f.publication().resume('alpha', { id: first, digest: firstDigest }, async () => {}), /different approval/);
  assert.deepEqual((await f.private()).routeAuthority.holds.alpha, { id: second, digest: secondDigest });
  assert.equal((await f.public()).routes[0].state, 'withheld');
});
test('a corrected approval must explicitly select the failed hold it replaces', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest);
  f.state().deployments[first].status = 'failed'; f.begin(second, secondDigest);
  await assert.rejects(f.publication().withhold('alpha', second, secondDigest), /different approval/);
  await f.publication().withhold('alpha', second, secondDigest, { replaces: { id: first, digest: firstDigest } });
  assert.deepEqual((await f.private()).routeAuthority.holds.alpha, { id: second, digest: secondDigest });
  assert.equal((await f.public()).routes[0].state, 'withheld');
});
test('replacement selection cannot override a live approval or revive an old completed release', async t => {
  const f = await active(t); f.begin(second, secondDigest); await f.publication().withhold('alpha', second, secondDigest);
  await assert.rejects(f.publication().withhold('alpha', first, firstDigest, { replaces: { id: second, digest: secondDigest } }), /different approval/);
  f.state().deployments[second].status = 'failed';
  await assert.rejects(f.publication().withhold('alpha', first, firstDigest, { replaces: { id: second, digest: secondDigest } }), /different approval/);
  assert.deepEqual((await f.private()).routeAuthority.holds.alpha, { id: second, digest: secondDigest });
  assert.equal((await f.public()).revision, '3');
});

for (const fault of ['before', 'after']) test(`fresh initialization resumes after ${fault}-create uncertainty`, async t => {
  const f = await fixture(t);
  const publication = new RoutePublication({ state: f.state(), path: f.path, policy, domain: 'localhost', savePrivate: () => saveJson(f.privatePath, f.state()), createPublic: async (path, record) => {
    if (fault === 'before') throw new Error('Create failed');
    await createRouteRecord(path, record, policy); throw new Error('Create result lost');
  } });
  await assert.rejects(publication.initialize(), /uncertain/);
  const restored = await f.reload(); await restored.resumeWithholding(); restored.assertReady();
  assert.deepEqual(await f.public(), { schema: 1, installation: 'a'.repeat(64), revision: '0', routes: [] });
  assert.equal((await f.private()).routeAuthority.pending, null);
});
test('withheld assertion binds a backend effect to the exact held approval and slot', async t => {
  const f = await active(t);
  await assert.rejects(f.publication().assertWithheld('alpha', first, firstDigest), /withholding for the exact approval/);
  await f.publication().withhold('alpha', first, firstDigest);
  await assert.rejects(f.publication().assertWithheld('alpha', second, secondDigest), /exact pinned approval/);
  await f.publication().assertWithheld('alpha', first, firstDigest);
  f.state().apps.alpha.slot = 'slot-2';
  await assert.rejects(f.publication().assertWithheld('alpha', first, firstDigest), /withholding for the exact approval/);
  assert.equal((await f.public()).routes[0].slot, 'slot-1');
});
test('a different file digest at the settled revision is refused without repair', async t => {
  const f = await active(t), record = await f.public(); record.routes[0].digest = secondDigest; await writeRouteRecord(f.path, record, policy);
  const restored = await f.reload(); await assert.rejects(restored.verifySettled(), /uncertain/);
  assert.equal((await f.public()).revision, '2'); assert.equal((await f.public()).routes[0].digest, secondDigest);
});
test('a resumed withholding intent cannot move its host to a different slot', async t => {
  const f = await active(t); f.failPublic('before'); await assert.rejects(f.publication().withdraw('alpha'), /uncertain/);
  const state = await f.private(); state.apps.alpha.slot = 'slot-2'; await saveJson(f.privatePath, state);
  const restored = await f.reload(); await assert.rejects(restored.resumeWithholding(), /uncertain/);
  assert.equal((await f.public()).routes[0].state, 'active'); assert.equal((await f.public()).routes[0].slot, 'slot-1');
});
test('overlapping withholding and withdrawal serialize into settled paused authority', async t => {
  const f = await active(t);
  await Promise.all([f.publication().withhold('alpha', first, firstDigest), f.publication().withdraw('alpha')]);
  assert.equal((await f.public()).revision, '4'); assert.equal((await f.public()).routes[0].state, 'withheld');
  assert.equal((await f.private()).routeAuthority.pending, null);
  assert.deepEqual((await f.private()).routeAuthority.holds.alpha, { id: first, digest: firstDigest });
});

test('an activation queued behind withholding cannot silently resume desired paused routing', async t => {
  const f = await active(t);
  const results = await Promise.allSettled([f.publication().withhold('alpha', first, firstDigest), f.publication().activate('alpha')]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.match(results[1].reason.message, /requested decision/);
  assert.equal((await f.public()).revision, '3'); assert.equal((await f.public()).routes[0].state, 'withheld');
});
for (const fault of ['before', 'after']) test(`superseding withdrawal survives ${fault}-private-intent uncertainty`, async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest); f.complete(); f.failPublic('after');
  await assert.rejects(f.publication().activate('alpha'), /uncertain/);
  const withdrawing = await f.reload(); f.failPrivate(fault);
  await assert.rejects(withdrawing.withholdPendingActive({ intent: 'active:2', id: first, digest: firstDigest }), /uncertain/);
  const restored = await f.reload();
  if (fault === 'before') await restored.withholdPendingActive({ intent: 'active:2', id: first, digest: firstDigest });
  else await restored.resumeWithholding();
  assert.equal((await f.public()).revision, '3'); assert.equal((await f.public()).routes[0].state, 'withheld');
  assert.equal((await f.private()).routeAuthority.pending, null);
  assert.deepEqual((await f.private()).routeAuthority.holds.alpha, { id: first, digest: firstDigest });
});
test('offline route removal refuses a tombstone for a different slot', async t => {
  const f = await active(t), state = retiredAlpha(f.state()); state.apps.alpha.retirement.previous.slot = 'slot-2';
  const observed = await readRouteRecord(f.path, policy);
  assert.throws(() => retireRouteAuthority(state, observed, { app: 'alpha', domain: 'localhost', sourcePolicy: policy, targetPolicy: policy }), /approval and slot/);
  assert.equal((await f.public()).routes[0].slot, 'slot-1');
});

test('a corrected release can replace the current completed hold after failed resume verification', async t => {
  const f = await active(t); await f.publication().withdraw('alpha');
  await assert.rejects(f.publication().resume('alpha', { id: first, digest: firstDigest }, async () => { throw new Error('Not ready'); }), /uncertain/);
  f.begin(second, secondDigest);
  await f.publication().withhold('alpha', second, secondDigest, { replaces: { id: first, digest: firstDigest } });
  await f.publication().assertWithheld('alpha', second, secondDigest);
  assert.deepEqual((await f.private()).routeAuthority.holds.alpha, { id: second, digest: secondDigest });
  f.complete(second); await f.publication().activate('alpha');
  assert.equal((await f.public()).routes[0].submission, second);
});
test('a corrected release can replace the completed hold of a withdrawn pending publication', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin(); await f.publication().withhold('alpha', first, firstDigest); f.complete(); f.failPublic('after');
  await assert.rejects(f.publication().activate('alpha'), /uncertain/);
  const restored = await f.reload(); await restored.withholdPendingActive({ intent: 'active:2', id: first, digest: firstDigest });
  f.begin(second, secondDigest);
  await restored.withhold('alpha', second, secondDigest, { replaces: { id: first, digest: firstDigest } });
  assert.equal((await f.public()).routes[0].state, 'withheld');
  assert.deepEqual((await f.private()).routeAuthority.holds.alpha, { id: second, digest: secondDigest });
});

test('the default state loader refuses the new authority capability', async t => {
  const f = await fixture(t); await f.publication().initialize();
  assert.throws(() => validateRetirementState(f.state(), []), /unsupported platform capability/);
  assert.equal((await f.public()).revision, '0');
});
test('live withdrawal refuses a private/public slot mismatch without changing authority', async t => {
  const f = await active(t); f.state().apps.alpha.slot = 'slot-2';
  await assert.rejects(f.publication().withdraw('alpha'), /uncertain/);
  assert.equal((await f.public()).revision, '2'); assert.equal((await f.public()).routes[0].slot, 'slot-1');
});
test('withdrawing an unpublished app reports no route without creating an intent', async t => {
  const f = await fixture(t); await f.publication().initialize(); f.begin();
  await assert.rejects(f.publication().withdraw('alpha'), /no published HTTP route/);
  assert.equal((await f.private()).routeAuthority.pending, null); assert.equal((await f.public()).revision, '0');
});
