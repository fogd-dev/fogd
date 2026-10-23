import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm, realpath, lstat, chown, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { artifactDigest } from '@fogd/runtime/artifact';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { restoreDurableInstallation } from '../src/recovery/durable-restore.mjs';
import { restoreDurableData } from '../src/recovery/durable-restore-data.mjs';
import { fingerprint, writeJson } from '../src/recovery/bundle.mjs';
import { readDurableRestorePlan } from '../src/runtime/durable-recovery-plan.mjs';
import { enrollDurableRestoration } from '../src/runtime/durable-installation.mjs';
import { restoreDurableRoutes } from '../src/runtime/durable-restoration.mjs';
import { assertDurableEnrollmentReady, beginDurableEnrollment } from '../src/runtime/enrollment-record.mjs';
import { durablePlanSha256 } from '../src/runtime/durable-config.mjs';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';
import { acquireStopFence } from '../src/runtime/launch-fence.mjs';
import { readRuntimePolicy } from '../../platform/src/runtime-policy-file.mjs';
import { initializeFreshRouteStores } from '../../platform/src/fresh-route-enrollment.mjs';
import { Controller } from '../../platform/src/controller.mjs';
import { readRouteRecord } from '../../platform/src/route-record-store.mjs';
import { planArtifactRetention } from '../../platform/src/artifact-retention.mjs';
import { validateRouteSnapshot } from '../../platform/src/route-snapshot.mjs';
import { durableBundleFixture } from './fixtures/durable-bundle.mjs';
import { durableEnrollmentFixture } from './fixtures/durable-enrollment.mjs';
import { durableDataTransport, gnuTar } from './fixtures/durable-data-transport.mjs';

const skip = gnuTar ? false : 'host GNU tar unavailable';
async function hostOwnership(path) {
  await chown(path, process.getuid(), process.getgid());
  if ((await lstat(path)).isDirectory()) for (const name of await readdir(path)) await hostOwnership(join(path, name));
}
async function sourceBundle(t) {
  const f = await durableBundleFixture(t, { stage: 'empty' }), roots = {};
  for (const role of ['controller', 'authority', 'enrollment']) { roots[role] = join(f.root, `source-${role}`); await mkdir(roots[role]); }
  await initializeFreshRouteStores({ profile: f.policy, binding: 'a'.repeat(64) }, roots);
  const slots = f.policy.fleets.map(fleet => ({ ...fleet, nodes: fleet.nodes.map(node => node.host) })), owners = {};
  const policy = { installation: runtimePolicyIdentity(f.policy), slots: slots.map(slot => slot.id) };
  const backend = { owner: async slot => owners[slot.id] || null, hasDeployment: async () => false, assertUnclaimed: async () => {},
    claim: async (slot, app) => { owners[slot.id] = { app }; }, publish: async () => randomUUID(), ready: async () => {}, applicationReady: async () => {}, migrate: async () => {}, applied: async () => [] };
  const c = new Controller({ dir: roots.controller, slots, backend, routeAuthority: { path: join(roots.authority, 'routes.json'), policy, verifyRuntime: async () => {} } });
  await c.init(); const id = randomUUID(), artifact = c.artifact(id); await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, 'index.js'), 'export default {fetch(){return new Response("saved")}}');
  await writeFile(join(artifact, 'wrangler.json'), JSON.stringify({ name: 'alpha', main: 'index.js', d1_databases: [] }));
  const request = { id, app: 'alpha', digest: await artifactDigest(artifact), resources: { script: 'alpha', d1: [], r2: [], durable: { bindings: [] } }, migrations: [], requiredSecrets: [], status: 'pending', step: 'submitted' };
  c.state.deployments[id] = request; await c.save(); await c.mutate(id, request.digest, 'approve');
  await c.setArtifactPin(id, request.digest, true);
  const retiredId = randomUUID(); await cp(artifact, c.artifact(retiredId), { recursive: true });
  c.state.deployments[retiredId] = { ...request, id: retiredId, status: 'rejected' }; await c.save();
  const retention = await planArtifactRetention(c.state, join(c.dir, 'artifacts'));
  const pruneReceipt = await c.pruneArtifacts(retention.plan);
  await writeFile(join(roots.controller, 'operator-secret.key'), 'source-private-value', { mode: 0o600 });
  // Use the actual producer's GNU tar flags, with ownership matching the host
  // helper identity. Native root ownership is a separate acceptance gate.
  for (const role of f.layout.archiveVolumes) {
    const path = role === 'controller' ? roots.controller : role === 'route-authority' ? roots.authority : join(f.root, 'staging');
    await hostOwnership(path);
    await rm(join(f.dir, `${role}.tar`)); execFileSync(gnuTar, ['--numeric-owner', '-cpf', join(f.dir, `${role}.tar`), '-C', path, '.']);
    f.manifest.files[`${role}.tar`] = await fingerprint(join(f.dir, `${role}.tar`));
  }
  const observed = await readRouteRecord(join(roots.authority, 'routes.json'), policy);
  f.manifest.routeAuthority = validateRouteSnapshot(c.state, observed, f.policy);
  await writeFile(join(f.dir, 'manifest.json'), JSON.stringify(f.manifest));
  return { ...f, c, owners, slots, routePolicy: policy, roots, request, pruneReceipt };
}
async function fixture(t) {
  const source = await sourceBundle(t), p = source.policy;
  const entry = { ...runtimeFamilies()[0], schema: 2, routing: 'durable', id: p.family, admission: p.admission,
    image: p.image, storageImage: p.storageImage, binarySha256: p.binarySha256, supervisorSha256: p.supervisorSha256 };
  const selection = { expectedIdentity: runtimePolicyIdentity(p) }, choose = { choose: () => entry };
  const plan = await readDurableRestorePlan(source.dir, 'recovered', selection, choose);
  const target = await durableEnrollmentFixture(t, { ...plan.target, entry }), sourceHost = join(source.root, 'host'); await mkdir(sourceHost, { mode: 0o700 });
  const volumePaths = Object.fromEntries(Object.keys(plan.target.config.volumes).map(role => [role, target.rolePath(role)]));
  const calls = [], dataTransport = durableDataTransport(plan.target.config, plan.target.policy, volumePaths, calls);
  let sourceRunning = false;
  const options = { plan: (directory, project, value) => readDurableRestorePlan(directory, project, value, choose), verify: async () => {},
    enrolled: async () => true, directory: () => sourceHost, related: async () => {},
    stopped: async (project, names) => { assert.equal(project, source.config.name); assert.deepEqual(names, Object.values(source.config.volumes).map(volume => volume.name)); if (sourceRunning) throw new Error('source writer'); },
    relation: async (project, sourceProject, config) => {
      assert.equal(project, 'recovered'); assert.equal(sourceProject, source.config.name);
      assert.deepEqual(target.events, []); await assert.rejects(assertDurableEnrollmentReady(target.directory), { code: 'ENROLLMENT_NOT_READY' });
      await writeJson(join(target.directory, 'recovery-source.json'), { schema: 1, project, sourceProject, volumes: Object.values(config.volumes).map(volume => volume.name) });
    },
    enroll: (selected, tasks) => enrollDurableRestoration(selected, tasks, target.options),
    data: async (directory, config, policy) => {
      await assert.rejects(assertDurableEnrollmentReady(target.directory), { code: 'ENROLLMENT_NOT_READY' });
      assert.equal(JSON.parse(await readFile(join(sourceHost, 'launch.pending.json'))).project, source.config.name);
      return restoreDurableData(directory, config, policy, { readVolume: dataTransport });
    },
    routes: async (config, input) => {
      await assert.rejects(assertDurableEnrollmentReady(target.directory), { code: 'ENROLLMENT_NOT_READY' });
      return restoreDurableRoutes(config, input, { run: target.options.run });
    },
    policy: (_image, _volume, env) => readRuntimePolicy(target.rolePath('runtime-policy'), env) };
  return { source, target, plan, selection, options, sourceHost, calls, output: join(source.root, 'restored'),
    run: () => restoreDurableInstallation(source.dir, 'recovered', join(source.root, 'restored'), selection, options),
    sourceRunning: value => { sourceRunning = value; } };
}
const uncertain = work => assert.rejects(work, error => error.code === 'DURABLE_RESTORE_UNCONFIRMED' && !error.cause && !/private-value|sha256|original_/.test(error.message));

test('stopped restore copies actual approved artifacts and private data before host completion, with HTTP withheld', { skip }, async t => {
  const f = await fixture(t), result = await f.run();
  const { config, policy } = result, target = f.target;
  assert.equal(config.name, 'recovered'); assert.deepEqual(policy.fleets, f.source.policy.fleets);
  await assertDurableEnrollmentReady(target.directory, { project: config.name, installation: runtimePolicyIdentity(policy), planSha256: durablePlanSha256(config, policy) });
  const state = JSON.parse(await readFile(join(target.rolePath('controller'), 'state.json')));
  assert.equal(state.apps.alpha.active, f.source.request.id); assert.equal(state.apps.alpha.route, 'paused');
  assert.equal(await readFile(join(target.rolePath('controller'), 'operator-secret.key'), 'utf8'), 'source-private-value');
  const copied = join(target.rolePath('controller'), 'artifacts', f.source.request.id);
  assert.equal(await artifactDigest(copied), f.source.request.digest);
  assert.deepEqual(state.artifactPins, { schema: 1, releases: { [f.source.request.id]: f.source.request.digest } });
  assert.equal(state.routeEnrollment.controller.path, await realpath(target.rolePath('controller')));
  const observed = await readRouteRecord(join(target.rolePath('route-authority'), 'routes.json'), f.source.routePolicy);
  assert.equal(observed.record.revision, '1'); assert.ok(observed.record.routes.every(route => route.state === 'withheld'));
  assert.equal((await readdir(f.sourceHost)).includes('launch.pending.json'), false);
  assert.ok(target.events.every(args => !args.some(value => ['start', 'up', 'rm', 'pull', 'build'].includes(value))));
  const controller = new Controller({ dir: target.rolePath('controller'), slots: f.source.slots,
    backend: { owner: async slot => f.source.owners[slot.id] || null, hasDeployment: async () => false },
    routeAuthority: { path: join(target.rolePath('route-authority'), 'routes.json'), policy: f.source.routePolicy, verifyRuntime: async () => assert.fail('HTTP remains withheld') } });
  await controller.init(); assert.equal(controller.routingStartupComplete, true);
  assert.deepEqual(controller.state.artifactPins, state.artifactPins);
  assert.deepEqual(controller.state.artifactPruning.last, f.source.pruneReceipt);
  for (const row of f.source.pruneReceipt.artifacts) {
    assert.deepEqual(controller.state.deployments[row.id].artifactPruned, { schema: 1, operation: f.source.pruneReceipt.id, bytes: row.bytes });
    await assert.rejects(lstat(controller.artifact(row.id)), { code: 'ENOENT' });
  }
  assert.equal((await planArtifactRetention(controller.state, join(controller.dir, 'artifacts'))).reclaimableArtifactBytes, 0);
});
test('data copy failure retains target stores and a permanent incomplete host enrollment', { skip }, async t => {
  const f = await fixture(t); f.options.data = async () => { throw new Error('injected copy failure'); };
  await uncertain(f.run()); await assert.rejects(assertDurableEnrollmentReady(f.target.directory), { code: 'ENROLLMENT_NOT_READY' });
  assert.ok((await readdir(f.target.directory)).includes('recovery-source.json'));
  assert.equal((await readdir(f.sourceHost)).includes('launch.pending.json'), false);
  await assert.rejects(readFile(join(f.target.rolePath('route-enrollment'), 'route-restoration.spent.json')), { code: 'ENOENT' });
});
test('a source writer appearing after data copy prevents route rebinding and host completion', { skip }, async t => {
  const f = await fixture(t), data = f.options.data;
  f.options.data = async (...args) => { const result = await data(...args); f.sourceRunning(true); return result; };
  await uncertain(f.run()); await assert.rejects(assertDurableEnrollmentReady(f.target.directory), { code: 'ENROLLMENT_NOT_READY' });
  await assert.rejects(readFile(join(f.target.rolePath('route-enrollment'), 'route-restoration.spent.json')), { code: 'ENOENT' });
});
test('existing or source-contained output refuses before destination enrollment', { skip }, async t => {
  const f = await fixture(t); await mkdir(f.output);
  await uncertain(f.run()); assert.deepEqual(f.target.events, []);
  await uncertain(restoreDurableInstallation(f.source.dir, 'recovered', join(f.source.dir, 'nested'), f.selection, f.options));
  assert.deepEqual(f.target.events, []); assert.deepEqual(await readdir(f.target.directory), []);
});
test('an existing source operation fence refuses before destination mutation', { skip }, async t => {
  const f = await fixture(t), fence = await acquireStopFence(f.sourceHost, { project: f.source.config.name, installation: 'source' });
  const before = await readFile(join(f.sourceHost, 'launch.pending.json')); await uncertain(f.run());
  assert.deepEqual(f.target.events, []); assert.deepEqual(await readFile(join(f.sourceHost, 'launch.pending.json')), before); await fence.release();
});
test('a failed source-fence release after host completion is never retried and causes no Docker mutation', { skip }, async t => {
  const f = await fixture(t); let releases = 0, calls;
  f.options.acquire = async (...args) => { const fence = await acquireStopFence(...args); return { release: async () => { releases++; calls = f.target.events.length; await fence.release(); throw new Error('lost release acknowledgment'); } }; };
  await uncertain(f.run()); assert.equal(releases, 1); assert.equal(f.target.events.length, calls);
  await assertDurableEnrollmentReady(f.target.directory);
});
test('prepared output never substitutes for a failed host enrollment completion', { skip }, async t => {
  const f = await fixture(t);
  f.target.options.begin = async (...args) => { await beginDurableEnrollment(...args); return { complete: async () => { throw new Error('injected host completion failure'); } }; };
  await uncertain(f.run()); await assert.rejects(assertDurableEnrollmentReady(f.target.directory), { code: 'ENROLLMENT_NOT_READY' });
  assert.equal(JSON.parse(await readFile(join(f.output, 'restored.json'))).enrollmentRequired, true);
  const state = JSON.parse(await readFile(join(f.target.rolePath('controller'), 'state.json')));
  assert.equal(state.routeAuthority.settled.revision, '1'); assert.equal(state.apps.alpha.route, 'paused');
});
test('a live destination observed after route rebinding cannot obtain host completion', { skip }, async t => {
  const f = await fixture(t), routes = f.options.routes, inspect = f.target.options.inspect; let live = false;
  f.target.options.inspect = async (...args) => {
    const inventory = await inspect(...args);
    if (live) { inventory.services.controller.running = true; inventory.services.controller.status = 'running'; }
    return inventory;
  };
  f.options.routes = async (...args) => {
    const result = await routes(...args); live = true; return result;
  };
  await uncertain(f.run()); await assert.rejects(assertDurableEnrollmentReady(f.target.directory), { code: 'ENROLLMENT_NOT_READY' });
});

test('route snapshot refuses a durable prune intent before any artifact removal', { skip }, async t => {
  const f = await sourceBundle(t), c = f.c, id = randomUUID();
  await cp(c.artifact(f.request.id), c.artifact(id), { recursive: true });
  c.state.deployments[id] = { ...f.request, id, status: 'rejected' }; await c.save();
  const plan = await planArtifactRetention(c.state, join(c.dir, 'artifacts')), save = c.save.bind(c);
  c.save = async () => { await save(); throw new Error('stop after durable intent'); };
  await assert.rejects(c.pruneArtifacts(plan.plan), /stop after durable intent/);
  assert.equal(await artifactDigest(c.artifact(id)), f.request.digest);
  const observed = await readRouteRecord(join(f.roots.authority, 'routes.json'), f.routePolicy);
  assert.throws(() => validateRouteSnapshot(c.state, observed, f.policy), /snapshot|prun/i);
  assert.deepEqual(await readRouteRecord(join(f.roots.authority, 'routes.json'), f.routePolicy), observed);
  assert.equal(c.state.apps.alpha.route, 'active');
});
