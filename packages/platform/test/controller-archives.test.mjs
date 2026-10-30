import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeRouteRecord } from '../src/route-record-store.mjs';
import { routePolicy } from '../src/route-restoration-plan.mjs';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.mjs';
import { archiveApprovalFixture, archive } from './fixtures/archive-approval.mjs';
import { validateAppArchives } from '../src/app-archive.mjs';
import { adminState } from '../src/admin-view.mjs';
import { operateDelivery, deliveryView } from '../src/admin-delivery.mjs';
import { operateDispatch, dispatchView } from '../src/admin-dispatch.mjs';

async function initialized(t, options) {
  const f = await archiveApprovalFixture(t, options);
  const c = new Controller({ ...f.settings, archiveProfile: f.profile });
  await c.init();
  return { ...f, c };
}

test('explicit internal profile starts a restored HTTP app held and allows reviewed approval before separate resume', async t => {
  const f = await initialized(t), before = await f.public();
  assert.equal(f.c.routingStartupComplete, true);
  assert.equal(f.c.state.apps.demo.archiveRecovery.status, 'pending');
  await assert.rejects(f.c.decideRoute('demo', 'resume', { deployment: f.release.id, digest: f.release.digest }));
  await assert.rejects(f.c.replaceSecrets('demo', { API_KEY: 'must-not-replace-before-approval' }), { code: 'APP_ARCHIVE_HELD' });
  await assert.rejects(f.c.issueCredential('premature builder', ['demo']), { code: 'APP_ARCHIVE_HELD' });
  const review = await f.c.archives.review('demo');
  await f.c.archives.approve('demo', review.selection, { actor: { kind: 'basic', name: 'recovery-owner' }, review: review.review });
  assert.equal(f.c.state.apps.demo.archiveRecovery, undefined);
  assert.equal(f.c.state.apps.demo.route, 'paused');
  assert.deepEqual(await f.public(), before);
  await f.c.decideRoute('demo', 'resume', { deployment: f.release.id, digest: f.release.digest });
  assert.equal(f.c.state.apps.demo.route, 'active');
  assert.equal((await f.public()).routes[0].state, 'active');
  validateAppArchives(f.c.state, f.profile);
  const restarted = new Controller({ ...f.settings, archiveProfile: f.profile }); await restarted.init();
  assert.equal(restarted.state.apps.demo.route, 'active');
});

for (const background of ['queue', 'cron']) test(`${background} cold start preserves pending owner approval and refuses all ordinary background mutations`, async t => {
  const f = await initialized(t, { background }), name = f.release.app;
  const operate = background === 'queue' ? operateDelivery : operateDispatch;
  const view = background === 'queue' ? deliveryView : dispatchView;
  const recovery = background === 'queue' ? 'queueRecovery' : 'cronRecovery';
  assert.equal(f.c.state.apps[name][recovery].checkedAt, undefined);
  assert.equal(view(f.c, name).operationAllowed, false);
  for (const action of ['observe', 'pause', 'resume', 'snapshot', 'acknowledge-recovery']) {
    await assert.rejects(f.c.exclusive(() => operate(f.c, name, action, {})), { code: 'APP_ARCHIVE_HELD' });
  }
  const review = await f.c.archives.review(name);
  await f.c.archives.approve(name, review.selection, { actor: { kind: 'basic', name: 'recovery-owner' }, review: review.review });
  assert.equal(f.c.state.apps[name].archiveRecovery, undefined);
  assert.equal(f.c.state.apps[name][recovery].status, 'pending');
  assert.equal(f.c.state.apps[name][recovery].checkError, null);
  assert.equal(typeof f.c.state.apps[name][recovery].checkedAt, 'number');
  assert.equal(f.c.state.apps[name].route, 'paused');
  assert.equal(view(f.c, name).resumeAllowed, false);
  validateAppArchives(f.c.state, f.profile);
});

test('admin inspection exposes only an archive summary and hides retained private app/runtime configuration', async t => {
  const f = await initialized(t), state = adminState(f.c), record = state.appArchives.records[archive];
  assert.deepEqual(Object.keys(record).sort(), ['at', 'digest', 'id', 'name', 'status']);
  assert.equal(record.name, 'demo'); assert.equal(record.status, 'restored');
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('private-current-vault-fixture'));
  assert.ok(!serialized.includes('archive-generations/'));
  assert.ok(!serialized.includes('targetIdentity'));
  assert.ok(!serialized.includes('slots/slot-1'));
  assert.ok(!serialized.includes(f.release.version));
});

test('default startup keeps archive admission closed before backend ownership checks', async t => {
  const f = await archiveApprovalFixture(t); let called = 0;
  const c = new Controller({ ...f.settings, backend: { owner: async () => { called++; throw Error('unexpected'); } } });
  await assert.rejects(c.init(), /unsupported platform capability/);
  assert.equal(called, 0);
});

test('internal profile must match the independently configured route and fleet identity', async t => {
  const f = await archiveApprovalFixture(t), profile = structuredClone(f.profile); profile.fleets[1].prefix = 'other/data';
  assert.throws(() => new Controller({ ...f.settings, archiveProfile: profile }), { code: 'APP_ARCHIVE_REVIEW_UNAVAILABLE' });
});

async function archivedOnly(t) {
  const f = await archiveApprovalFixture(t), profile = f.restore.sourceProfile;
  const state = { ...structuredClone(f.restore.source.state), routeEnrollment: f.c.state.routeEnrollment,
    artifactPins: { schema: 1, releases: { [f.release.id]: f.release.digest } } };
  await writeFile(join(f.paths.controller, 'state.json'), JSON.stringify(state));
  await writeRouteRecord(f.settings.routeAuthority.path, f.restore.source.authority.record, routePolicy(profile));
  const settings = { ...f.settings, slots: profile.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) })),
    archiveProfile: profile, backend: { ...f.settings.backend, owner: async () => null },
    routeAuthority: { ...f.settings.routeAuthority, policy: routePolicy(profile) } };
  return { ...f, profile, state, settings };
}

test('archived-only startup keeps name and artifact retention while reporting free configured capacity', async t => {
  const f = await archivedOnly(t), c = new Controller(f.settings); await c.init();
  const state = adminState(c);
  assert.equal(c.state.apps.demo.route, 'archived');
  assert.equal(c.state.apps.demo.slot, null);
  assert.equal(state.capacity.slots.available, 2);
  assert.deepEqual(c.state.artifactPins, f.state.artifactPins);
  assert.ok(c.quota.describe().retainedArtifactBytes > 0);
  assert.throws(() => c.available('demo'), { code: 'APP_ARCHIVE_HELD' });
  await assert.rejects(c.archives.review('demo'), { code: 'APP_ARCHIVE_REVIEW_UNAVAILABLE' });
});

test('a configured native fleet claiming an archived name refuses startup without rewriting the archive', async t => {
  const f = await archivedOnly(t), c = new Controller({ ...f.settings, backend: { ...f.settings.backend, owner: async () => ({ app: 'demo' }) } });
  await assert.rejects(c.init(), /Archived app owns a configured fleet/);
  const state = await f.disk();
  assert.equal(state.apps.demo.route, 'archived');
  assert.equal(state.apps.demo.quarantined, undefined);
  assert.deepEqual(state.artifactPins, f.state.artifactPins);
});

test('removing capability markers cannot make archive metadata acceptable to default startup', async t => {
  const f = await archiveApprovalFixture(t), state = await f.disk();
  state.requirements = state.requirements.filter(value => value !== 'fogd-app-archive-v1');
  await writeFile(join(f.paths.controller, 'state.json'), JSON.stringify(state));
  let called = 0;
  const c = new Controller({ ...f.settings, backend: { owner: async () => { called++; return null; } } });
  await assert.rejects(c.init(), /unsupported platform capability/);
  assert.equal(called, 0);
});

for (const background of ['queue', 'cron']) test(`${background} execution requires owner approval, separate loss acknowledgment and explicit resume`, async t => {
  const f = await initialized(t, { background }), name = f.release.app;
  const operate = background === 'queue' ? operateDelivery : operateDispatch;
  const view = background === 'queue' ? deliveryView : dispatchView;
  const recovery = background === 'queue' ? 'queueRecovery' : 'cronRecovery';
  const control = background === 'queue' ? 'delivery' : 'dispatch';
  const review = await f.c.archives.review(name);
  await f.c.archives.approve(name, review.selection, { actor: { kind: 'basic', name: 'owner' }, review: review.review });
  const recorded = view(f.c, name);
  await f.c.exclusive(() => operate(f.c, name, 'acknowledge-recovery', { deployment: f.release.id, digest: f.release.digest,
    recovery: recorded.recovery.id, review: recorded.recovery.review, acceptPossibleLoss: true }));
  assert.equal(f.c.state.apps[name][recovery].status, 'acknowledged');
  assert.equal(f.c.state.apps[name][control].observed, 'paused');
  assert.equal(f.c.state.apps[name].route, 'active');
  assert.equal((await f.public()).routes[0].state, 'active');
  await f.c.exclusive(() => operate(f.c, name, 'resume', { deployment: f.release.id, digest: f.release.digest }));
  assert.equal(f.c.state.apps[name][control].desired, 'running');
  assert.equal(f.c.state.apps[name][control].observed, 'running');
  const restarted = new Controller({ ...f.settings, archiveProfile: f.profile }); await restarted.init();
  assert.equal(restarted.state.apps[name][recovery].status, 'acknowledged');
  assert.equal(restarted.state.apps[name][control].desired, 'running');
  assert.equal(restarted.state.apps[name].route, 'active');
  validateAppArchives(restarted.state, f.profile);
});
