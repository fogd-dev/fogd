import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { archiveApprovalFixture, archive } from './fixtures/archive-approval.mjs';
import { approveAppArchiveRecovery } from '../src/app-archive-approval.mjs';
import { validateAppArchives } from '../src/app-archive.mjs';
import { validateAppArchiveSnapshot } from '../src/app-archive-routes.mjs';
import { readRouteRecord } from '../src/route-record-store.mjs';
import { routePolicy } from '../src/route-restoration-plan.mjs';
import { saveJson } from '../src/store.mjs';

const refused = { code: 'APP_ARCHIVE_APPROVAL_REFUSED' };
test('owner approval consumes a restored gate in the same save as attributed success while execution stays held', async t => {
  const f = await archiveApprovalFixture(t), before = await f.public(), effects = [...f.source.effects];
  const result = await approveAppArchiveRecovery(f.c, f.profile, f.input, f.context());
  assert.deepEqual(result, { archive, identity: f.input.identity, deployment: f.release.id, digest: f.release.digest, state: 'approved', execution: 'held' });
  const state = await f.disk(), decision = state.decisions.at(-1);
  assert.equal(state.appArchives.records[archive].status, 'recovered');
  assert.equal(state.appArchives.records[archive].restoration.decision, decision.id);
  assert.equal(state.apps.demo.archiveRecovery, undefined);
  assert.equal(state.apps.demo.route, 'paused');
  assert.equal(decision.outcome, 'succeeded');
  assert.deepEqual(decision.actor, { kind: 'basic', name: 'recovery-owner' });
  assert.equal(decision.secretRevision, f.secret.revision);
  assert.deepEqual(await f.public(), before);
  assert.deepEqual(f.source.effects, effects);
  assert.deepEqual(await readdir(f.c.secrets.execution), []);
  assert.ok(!JSON.stringify(result).includes('private-'));
  validateAppArchives(state, f.profile);
  validateAppArchiveSnapshot(state, await readRouteRecord(f.settings.routeAuthority.path, routePolicy(f.profile)), f.profile);
});

test('a consumed archive refuses a repeated approval without appending another intent', async t => {
  const f = await archiveApprovalFixture(t); await approveAppArchiveRecovery(f.c, f.profile, f.input, f.context());
  const state = await f.disk();
  await assert.rejects(approveAppArchiveRecovery(f.c, f.profile, f.input, f.context()), refused);
  assert.deepEqual(await f.disk(), state);
});

test('a newer current vault revision cannot substitute for the pinned restored release', async t => {
  const f = await archiveApprovalFixture(t), revision = await f.c.secrets.replace('demo', { API_KEY: 'private-newer-vault-value' });
  f.input.secretRevision = revision.revision;
  await assert.rejects(approveAppArchiveRecovery(f.c, f.profile, f.input, f.context()), refused);
  assert.equal((await f.disk()).apps.demo.archiveRecovery.status, 'pending');
});

test('missing pinned current-vault bytes refuse even when the old source vault still has them', async t => {
  const f = await archiveApprovalFixture(t);
  await rm(join(f.c.secrets.dir, f.secret.revision + '.json'));
  assert.ok(await readFile(join(f.source.controller.secrets.dir, f.secret.revision + '.json')));
  await assert.rejects(approveAppArchiveRecovery(f.c, f.profile, f.input, f.context()), refused);
  const state = await f.disk();
  assert.equal(state.apps.demo.archiveRecovery.status, 'pending');
  assert.equal(state.decisions.at(-1).outcome, 'refused');
  assert.equal(f.verifications(), 0);
});

for (const [name, alter] of [
  ['missing migration', f => f.migrationRows([])],
  ['unknown migration', f => f.migrationRows([{ database: 'demo-demo-db', name: 'unknown.sql' }])],
  ['unavailable runtime', f => f.failNative()],
  ['changed artifact', async f => writeFile(join(f.c.artifact(f.release.id), 'worker/index.js'), 'export default {};')],
  ['different snapshot', f => { f.input.snapshot = 'e'.repeat(64); }],
]) test(`recovery approval refuses ${name} and keeps the gate and route held`, async t => {
  const f = await archiveApprovalFixture(t), before = await f.public(); await alter(f);
  await assert.rejects(approveAppArchiveRecovery(f.c, f.profile, f.input, f.context()), refused);
  const state = await f.disk();
  assert.equal(state.apps.demo.archiveRecovery.status, 'pending');
  assert.equal(state.apps.demo.route, 'paused');
  assert.deepEqual(await f.public(), before);
});

for (const phase of ['intent', 'completion']) for (const committed of [false, true]) test(`lost ${phase} save acknowledgment preserves the authoritative gate: committed=${committed}`, async t => {
  let armed = false;
  const f = await archiveApprovalFixture(t, { persist: async (path, state) => {
    const selected = state.decisions?.at(-1)?.outcome === (phase === 'intent' ? 'started' : 'succeeded');
    if (armed && selected) { if (committed) await saveJson(path, state); throw Error('private-persistence-diagnostic'); }
    await saveJson(path, state);
  } });
  armed = true;
  await assert.rejects(approveAppArchiveRecovery(f.c, f.profile, f.input, f.context()), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
  const state = await f.disk(), completed = phase === 'completion' && committed;
  assert.equal(state.appArchives.records[archive].status, completed ? 'recovered' : 'restored');
  assert.equal(state.apps.demo.archiveRecovery?.status, completed ? undefined : 'pending');
  assert.equal(state.apps.demo.route, 'paused');
  assert.ok((await f.public()).routes.every(route => route.state === 'withheld'));
  validateAppArchives(state, f.profile);
  await assert.rejects(approveAppArchiveRecovery(f.c, f.profile, f.input, f.context()), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
});

for (const background of ['queue', 'cron']) test(`${background} approval consumes only the archive gate and retains pending loss/replay recovery`, async t => {
  const f = await archiveApprovalFixture(t, { background }), name = f.release.app, before = await f.public();
  const original = structuredClone(f.c.state.apps[name]);
  await approveAppArchiveRecovery(f.c, f.profile, f.input, f.context());
  const state = await f.disk(), app = state.apps[name];
  assert.equal(state.appArchives.records[archive].status, 'recovered');
  assert.equal(app.archiveRecovery, undefined);
  assert.equal(app.route, 'paused');
  assert.deepEqual(app.queueRecovery, original.queueRecovery);
  assert.deepEqual(app.cronRecovery, original.cronRecovery);
  assert.deepEqual(app.delivery, original.delivery);
  assert.deepEqual(app.dispatch, original.dispatch);
  assert.deepEqual(await f.public(), before);
  validateAppArchiveSnapshot(state, await readRouteRecord(f.settings.routeAuthority.path, routePolicy(f.profile)), f.profile);
});

for (const background of ['queue', 'cron']) test(`${background} approval refuses a native background runtime that is no longer held`, async t => {
  const f = await archiveApprovalFixture(t, { background }), name = f.release.app;
  const surface = background === 'queue' ? f.c.backend.queues : f.c.backend.crons;
  surface.snapshot = async () => ({ paused: false });
  await assert.rejects(approveAppArchiveRecovery(f.c, f.profile, f.input, f.context()), refused);
  assert.equal((await f.disk()).apps[name].archiveRecovery.status, 'pending');
  assert.ok((await f.public()).routes.every(route => route.state === 'withheld'));
});

test('recovered archive validation refuses reusing the original pre-restoration approval', async t => {
  const f = await archiveApprovalFixture(t); await approveAppArchiveRecovery(f.c, f.profile, f.input, f.context());
  const state = await f.disk(); state.appArchives.records[archive].restoration.decision = state.decisions[0].id;
  assert.throws(() => validateAppArchives(state, f.profile), { code: 'APP_ARCHIVE_REFUSED' });
});

test('a stale owner review refuses before inspecting the runtime', async t => {
  const f = await archiveApprovalFixture(t), context = f.context();
  f.c.state.apps.demo.reason = 'changed recovery context';
  await assert.rejects(approveAppArchiveRecovery(f.c, f.profile, f.input, context), refused);
  assert.equal(f.verifications(), 0);
  assert.equal((await f.disk()).apps.demo.archiveRecovery.status, 'pending');
});

test('changing pinned vault bytes during native checks refuses completion', async t => {
  const f = await archiveApprovalFixture(t);
  f.c.routes.options.verifyRuntime = async () => writeFile(join(f.c.secrets.dir, f.secret.revision + '.json'),
    JSON.stringify({ app: 'demo', values: { API_KEY: 'private-changed-during-review' } }));
  await assert.rejects(approveAppArchiveRecovery(f.c, f.profile, f.input, f.context()), refused);
  const state = await f.disk();
  assert.equal(state.apps.demo.archiveRecovery.status, 'pending');
  assert.equal(state.decisions.at(-1).outcome, 'unconfirmed');
  assert.ok(!JSON.stringify(state.decisions).includes('private-'));
});

test('a changed cron hold revision refuses even when the native schedule reports paused', async t => {
  const f = await archiveApprovalFixture(t, { background: 'cron' });
  const snapshot = f.c.backend.crons.snapshot;
  f.c.backend.crons.snapshot = async (...args) => { const observed = await snapshot(...args); return { ...observed, revision: observed.revision + 1 }; };
  await assert.rejects(approveAppArchiveRecovery(f.c, f.profile, f.input, f.context()), refused);
  assert.equal((await f.disk()).apps.refresh.archiveRecovery.status, 'pending');
});

test('failed native verification records an unconfirmed decision rather than promising absence of effects', async t => {
  const f = await archiveApprovalFixture(t); f.failNative();
  await assert.rejects(approveAppArchiveRecovery(f.c, f.profile, f.input, f.context()), refused);
  const state = await f.disk();
  assert.equal(state.decisions.at(-1).outcome, 'unconfirmed');
  assert.equal(state.apps.demo.archiveRecovery.status, 'pending');
  assert.equal(state.apps.demo.route, 'paused');
  assert.equal((await f.public()).routes[0].state, 'withheld');
});
