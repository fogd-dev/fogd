import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture as queued } from '../../platform/test/fixtures/queue-controller.mjs';
import { fixture as scheduled } from '../../platform/test/fixtures/cron-controller.mjs';
import { operateDelivery } from '../../platform/src/admin-delivery.mjs';
import { operateDispatch } from '../../platform/src/admin-dispatch.mjs';
import { prepareAppArchiveRoutes } from '@fogd/platform/app-archive-routes';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { readRouteRecord } from '../../platform/src/route-record-store.mjs';
import { verifyAppArchiveBundle } from '../src/recovery/durable-bundle.mjs';
import { durableBundleFixture } from './fixtures/durable-bundle.mjs';
import { archiveConfig, packRole, saveManifest, generation } from './fixtures/app-archive-data.mjs';

async function archivedBackground(t, family) {
  const bundle = await durableBundleFixture(t, { stage: 'empty' }), path = join(bundle.root, 'background-authority'); await mkdir(path, { mode: 0o755 });
  const policy = { installation: runtimePolicyIdentity(bundle.policy), slots: ['slot-1', 'slot-2'] };
  const slots = bundle.policy.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
  const f = await family.fixture(t, { slots, routeAuthority: { path: join(path, 'routes.json'), policy, verifyRuntime: async () => {} } });
  const release = await f.request(); await f.c.mutate(release.id, release.digest, 'approve');
  if (family.app === 'imports') f.backend.queues.snapshot = async () => ({ paused: true, stored: 1, backlogCount: 1, backlogBytes: 10, oldestMessageTimestamp: Date.now() - 1000 });
  await f.c.exclusive(() => family.operate(f.c, family.app, 'snapshot', { deployment: release.id, digest: release.digest }));
  const target = structuredClone(bundle.policy); target.fleets[0].prefix = `archive-generations/${generation}`;
  target.fleets[0].nodes = target.fleets[0].nodes.map(node => ({ ...node, id: `${node.host}-${generation}` }));
  const projected = prepareAppArchiveRoutes({ profile: target, sourceProfile: bundle.policy,
    source: { state: f.c.state, authority: await readRouteRecord(join(path, 'routes.json'), policy) }, snapshot: 'a'.repeat(64), binding: 'b'.repeat(64), domain: 'localhost',
    archive: { app: family.app, digest: release.digest, id: generation, at: new Date().toISOString() } });
  const controller = join(bundle.root, 'archived-controller'), authority = join(bundle.root, 'archived-authority');
  await cp(f.c.dir, controller, { recursive: true }); await mkdir(authority, { mode: 0o755 });
  await writeFile(join(controller, 'state.json'), JSON.stringify(projected.state)); await writeFile(join(authority, 'routes.json'), JSON.stringify(projected.record, null, 2));
  await packRole(bundle.dir, 'controller', controller); await packRole(bundle.dir, 'route-authority', authority);
  const config = archiveConfig(bundle.config, target, 'fogd-archived-'+family.app); await writeFile(join(bundle.dir, 'compose.json'), JSON.stringify(config));
  bundle.manifest.sourceProject = config.name; bundle.manifest.routeAuthority = { schema: 1, installation: projected.record.installation, revision: '1', sha256: projected.state.routeAuthority.settled.digest };
  await saveManifest(bundle.dir, bundle.manifest);
  return { ...bundle, target, original: f.c.state, projected };
}
const queue = { app: 'imports', fixture: queued, operate: operateDelivery }, cron = { app: 'refresh', fixture: scheduled, operate: operateDispatch };

test('archive snapshot accounts for held queue history even after its old backlog receipt expires', async t => {
  const f = await archivedBackground(t, queue), receipt = f.original.apps.imports.queueSnapshot;
  const verified = await verifyAppArchiveBundle(f.dir, f.target, receipt.expiresAt + 1);
  assert.equal(verified.state.apps.imports.route, 'archived');
  assert.equal(verified.state.apps.imports.slot, null);
  assert.deepEqual(verified.state.appArchives.records[generation].app.queueSnapshot, receipt);
  assert.equal(verified.state.appArchives.records[generation].app.delivery.observed, 'paused');
});
test('archive snapshot accounts for held scheduled history without restoring operational dispatch', async t => {
  const f = await archivedBackground(t, cron), verified = await verifyAppArchiveBundle(f.dir, f.target);
  assert.equal(verified.state.apps.refresh.route, 'archived');
  assert.equal(verified.state.apps.refresh.dispatch, undefined);
  assert.deepEqual(verified.state.appArchives.records[generation].app.cronSnapshot, f.original.apps.refresh.cronSnapshot);
  assert.equal(verified.state.appArchives.records[generation].app.dispatch.observed, 'paused');
});
test('archive snapshot refuses live queue recovery evidence for an inactive archived name', async t => {
  const f = await archivedBackground(t, queue);
  f.manifest.queueRecovery = { schema: 1, apps: { imports: f.original.apps.imports.queueSnapshot } }; await saveManifest(f.dir, f.manifest);
  await assert.rejects(verifyAppArchiveBundle(f.dir, f.target), { code: 'DURABLE_BUNDLE_REFUSED' });
});
