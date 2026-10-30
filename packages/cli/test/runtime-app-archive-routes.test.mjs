import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { archiveDurableRoutes, restoreArchivedDurableRoutes } from '../src/runtime/durable-restoration.mjs';
import { durableLegacyBase, durableRuntimeConfig } from '../src/runtime/durable-config.mjs';
import { restoreAppArchiveStores, restoreAppArchiveRecoveryStores } from '@fogd/platform/app-archive-routes';
import { initializeFreshRouteStores } from '../../platform/src/fresh-route-enrollment.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { readRouteRecord } from '../../platform/src/route-record-store.mjs';
import { durableBundleFixture } from './fixtures/durable-bundle.mjs';

const generation = '10000000-0000-4000-8000-000000000001';
async function fixture(t) {
  const f = await durableBundleFixture(t), profile = structuredClone(f.policy), base = durableLegacyBase(f.config);
  const fleet = profile.fleets[0]; fleet.prefix = `archive-generations/${generation}`;
  fleet.nodes = fleet.nodes.map(node => ({ ...node, id: `${node.host}-${generation}` }));
  const slots = profile.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
  for (const name of ['controller', 'workerd']) base.services[name].environment.FOGD_SLOTS = JSON.stringify(slots);
  for (const node of fleet.nodes) {
    base.services[node.host].environment.CELLD_NODE = node.id;
    base.services[node.host].environment.CELLD_BUCKET = `s3://${profile.bucket}/${fleet.prefix}`;
  }
  const config = durableRuntimeConfig(base, profile), selected = f.state.deployments[f.state.apps.alpha.active];
  const input = { profile, sourceProfile: f.policy, source: { state: f.state,
    authority: await readRouteRecord(join(f.authority, 'routes.json'), { installation: runtimePolicyIdentity(f.policy), slots: ['slot-1', 'slot-2'] }) },
    snapshot: 'a'.repeat(64), binding: 'b'.repeat(64), domain: 'localhost', archive: { app: 'alpha', digest: selected.digest, id: generation, at: '2026-10-30T02:00:00.000Z' } };
  return { ...f, input, targetConfig: config };
}
async function stores(root, suffix, input) {
  const paths = { controller: join(root, suffix+'-controller'), authority: join(root, suffix+'-authority'), enrollment: join(root, suffix+'-enrollment') };
  await Promise.all(Object.values(paths).map(path => mkdir(path)));
  await initializeFreshRouteStores({ profile: input.profile, binding: input.binding }, paths);
  return paths;
}

test('host archive and recovery adapters use fixed offline helpers and verify actual replacement stores', async t => {
  const f = await fixture(t), archivedPaths = await stores(f.root, 'archived', f.input), calls = [];
  const archiveRun = async (args, io) => { calls.push(args); return JSON.stringify(await restoreAppArchiveStores(JSON.parse(io.inputText), archivedPaths)); };
  const archived = await archiveDurableRoutes(f.targetConfig, f.input, { run: archiveRun });
  const state = JSON.parse(await readFile(join(archivedPaths.controller, 'state.json')));
  const authority = await readRouteRecord(join(archivedPaths.authority, 'routes.json'), { installation: runtimePolicyIdentity(f.input.profile), slots: ['slot-1', 'slot-2'] });
  const restore = { profile: f.policy, sourceProfile: f.input.profile, source: { state, authority }, snapshot: 'c'.repeat(64), binding: 'd'.repeat(64), domain: 'localhost',
    restore: { archive: generation, expectedIdentity: state.appArchives.records[generation].identity, slot: 'slot-1' } };
  const restoredPaths = await stores(f.root, 'restored', restore);
  const restoreRun = async (args, io) => { calls.push(args); return JSON.stringify(await restoreAppArchiveRecoveryStores(JSON.parse(io.inputText), restoredPaths)); };
  const receipt = await restoreArchivedDurableRoutes(f.config, restore, { run: restoreRun });
  const saved = JSON.parse(await readFile(join(restoredPaths.controller, 'state.json')));
  assert.equal(archived.sha256, authority.digest);
  assert.equal(receipt.snapshot, restore.snapshot);
  assert.equal(saved.apps.alpha.route, 'paused');
  assert.equal(saved.apps.alpha.archiveRecovery.status, 'pending');
  assert.deepEqual(calls[0].slice(-2), ['packages/platform/src/import-app-archive-routes.mjs', 'archive']);
  assert.deepEqual(calls[1].slice(-2), ['packages/platform/src/import-app-archive-routes.mjs', 'restore']);
  assert.deepEqual(calls[0].slice(0, 12), ['run', '--pull', 'never', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']);
  assert.equal(calls[0].filter(arg => arg === '--mount').length, 3);
});

test('host archive adapter refuses stale authority before starting its helper', async t => {
  const f = await fixture(t); f.input.source.authority.digest = '0'.repeat(64);
  let called = false;
  await assert.rejects(archiveDurableRoutes(f.targetConfig, f.input, { run: async () => { called = true; } }), { code: 'DURABLE_RESTORATION_REFUSED' });
  assert.equal(called, false);
});
