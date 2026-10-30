import { mkdir, cp, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { fixture as queued } from './queue-controller.mjs';
import { fixture as scheduled } from './cron-controller.mjs';
import { operateDelivery } from '../../src/admin-delivery.mjs';
import { operateDispatch } from '../../src/admin-dispatch.mjs';
import { decisionFixture } from './decision-controller.mjs';
import { policy } from './runtime-policy.mjs';
import { translateConfig, resourceIdentity, artifactDigest } from '@fogd/runtime/artifact';
import { Controller } from '../../src/controller.mjs';
import { saveJson } from '../../src/store.mjs';
import { prepareAppArchiveRoutes, restoreAppArchiveRecoveryStores } from '../../src/app-archive-routes.mjs';
import { initializeFreshRouteStores } from '../../src/fresh-route-enrollment.mjs';
import { routePolicy } from '../../src/route-restoration-plan.mjs';
import { routeRecordDigest } from '../../src/route-record-store.mjs';
import { decisionReviewToken } from '../../src/decision-history.mjs';

export const archive = '33333333-3333-4333-8333-333333333333';
export async function archiveApprovalFixture(t, { persist = saveJson, background, runtime, privateBackground = false } = {}) {
  const sourceProfile = { ...policy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'],
    ...(runtime ? { family: runtime.id, image: runtime.image, storageImage: runtime.storageImage, binarySha256: runtime.binarySha256, supervisorSha256: runtime.supervisorSha256 } : {}) };
  const slots = profile => profile.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
  const source = await approvalSource(t, slots(sourceProfile), background, privateBackground), c = source.controller;
  const release = source.release, secret = source.secret, name = release.app;
  let rows = structuredClone(c.state.apps[name].migrations);
  const record = { schema: 1, installation: routePolicy(sourceProfile).installation, revision: '1',
    routes: [{ host: name + '.localhost', state: 'active', slot: 'slot-1', submission: release.id, digest: release.digest }] };
  const digest = routeRecordDigest(record, routePolicy(sourceProfile));
  c.state.requirements = [...new Set([...(c.state.requirements || []), 'fogd-route-authority-v1'])];
  c.state.routeAuthority = { schema: 1, installation: record.installation, holds: {}, settled: { revision: '1', digest }, pending: null };
  const archivedProfile = structuredClone(sourceProfile);
  archivedProfile.fleets[0].prefix = 'archive-generations/' + archive;
  archivedProfile.fleets[0].nodes = archivedProfile.fleets[0].nodes.map(node => ({ ...node, id: node.host + '-' + archive }));
  const archived = prepareAppArchiveRoutes({ profile: archivedProfile, sourceProfile, source: { state: c.state, authority: { record, digest } },
    snapshot: 'a'.repeat(64), binding: 'b'.repeat(64), domain: 'localhost', archive: { app: name, digest: release.digest, id: archive, at: '2026-10-30T02:00:00.000Z' } });
  const profile = structuredClone(archivedProfile);
  profile.fleets[1].prefix = sourceProfile.fleets[0].prefix;
  profile.fleets[1].nodes = profile.fleets[1].nodes.map((node, index) => ({ ...node, id: sourceProfile.fleets[0].nodes[index].id }));
  const paths = { controller: join(source.root, 'restored-private'), authority: join(source.root, 'restored-authority'), enrollment: join(source.root, 'restored-enrollment') };
  await Promise.all(Object.values(paths).map(path => mkdir(path)));
  const binding = 'c'.repeat(64);
  await initializeFreshRouteStores({ profile, binding }, paths);
  for (const name of ['artifacts', 'secrets']) await cp(join(c.dir, name), join(paths.controller, name), { recursive: true });
  const restore = { profile, sourceProfile: archivedProfile,
    source: { state: archived.state, authority: { record: archived.record, digest: archived.state.routeAuthority.settled.digest } },
    snapshot: 'd'.repeat(64), binding, domain: 'localhost', restore: { archive, expectedIdentity: archived.state.appArchives.records[archive].identity, slot: 'slot-2' } };
  await restoreAppArchiveRecoveryStores(restore, paths);
  let nativeFailure = false, verifications = 0;
  const backend = { ...c.backend, owner: async slot => slot.id === 'slot-2' ? { app: name } : null, inspectMigrations: async () => structuredClone(rows) };
  const settings = { dir: paths.controller, slots: slots(profile), backend, persist, reportStorageFailure: () => {},
    routeAuthority: { path: join(paths.authority, 'routes.json'), policy: routePolicy(profile), verifyRuntime: async () => {
      verifications++; if (nativeFailure) throw Error('private-native-diagnostic');
    } } };
  const restored = new Controller(settings);
  // Staged internal operation only: ordinary init still rejects archive state.
  restored.state = JSON.parse(await readFile(join(paths.controller, 'state.json')));
  await restored.secrets.init();
  const input = { archive, identity: archived.state.appArchives.records[archive].identity, snapshot: 'd'.repeat(64),
    deployment: release.id, digest: release.digest, secretRevision: secret.revision };
  const context = () => ({ actor: { kind: 'basic', name: 'recovery-owner' }, review: decisionReviewToken(restored, release.id) });
  return { c: restored, profile, input, context, paths, settings, source, release, secret, restore, verifications: () => verifications,
    failNative: () => { nativeFailure = true; }, migrationRows: value => { rows = value; },
    disk: async () => JSON.parse(await readFile(join(paths.controller, 'state.json'))),
    public: async () => JSON.parse(await readFile(join(paths.authority, 'routes.json'))) };
}

async function approvalSource(t, slots, background, privateBackground) {
  if (background) {
    const family = background === 'queue' ? { fixture: queued, operate: operateDelivery } : { fixture: scheduled, operate: operateDispatch };
    const source = await family.fixture(t, { slots }), c = source.c, release = await source.request();
    // These old controller fixtures stage private artifacts. Recovery review
    // exercises ordinary canonical admission, so canonicalize before approval.
    const path = join(c.artifact(release.id), 'wrangler.json');
    const config = translateConfig(JSON.parse(await readFile(path)), release.app, { cronApps: true });
    let secret = { revision: null };
    if (privateBackground) {
      release.requiredSecrets = ['API_KEY'];
      c.backend.applicationReady = async () => {};
      await writeFile(join(c.artifact(release.id), 'fogd-deployment.json'), JSON.stringify({ requiredSecrets: release.requiredSecrets }));
      secret = await c.replaceSecrets(release.app, { API_KEY: 'private-background-original' });
    }
    await writeFile(path, JSON.stringify(config));
    release.resources = resourceIdentity(config); release.digest = await artifactDigest(c.artifact(release.id));
    if (background === 'queue') {
      const resume = c.backend.queues.resume;
      c.backend.queues.resume = (slot, queue, version) => {
        assert.equal(queue, config.queues.consumers[0].queue);
        return resume(slot, 'jobs', version);
      };
    }
    await c.mutate(release.id, release.digest, 'approve', secret.revision, undefined,
      { actor: { kind: 'basic', name: 'original-owner' }, review: decisionReviewToken(c, release.id) });
    if (background === 'queue') c.backend.queues.snapshot = async () => ({ paused: true, stored: 0, backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: null });
    await family.operate(c, release.app, 'snapshot', { deployment: release.id, digest: release.digest });
    const root = await mkdtemp(join(tmpdir(), 'fogd-archive-approval-background-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return { controller: c, root, release, secret, effects: source.events || [] };
  }
  const source = await decisionFixture(t, { slots }), c = source.controller;
  const release = await source.submit('demo', { config: { secrets: { required: ['API_KEY'] }, d1_databases: [{ binding: 'DB', database_name: 'demo-db' }] },
    files: { 'db/migrations/0001_initial.sql': 'CREATE TABLE records (id TEXT PRIMARY KEY);' } });
  const secret = await c.replaceSecrets('demo', { API_KEY: 'private-current-vault-fixture' });
  let rows = [];
  const migrate = c.backend.migrate;
  c.backend.migrate = async (...args) => { await migrate(...args); rows = release.migrations.map(({ database, name }) => ({ database, name })); };
  c.backend.applied = async () => structuredClone(rows);
  await c.mutate(release.id, release.digest, 'approve', secret.revision, undefined,
    { actor: { kind: 'basic', name: 'original-owner' }, review: decisionReviewToken(c, release.id) });
  return { ...source, release, secret };
}
