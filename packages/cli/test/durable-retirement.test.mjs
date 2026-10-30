import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile, cp, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { artifactDigest } from '@fogd/runtime/artifact';
import { retireDurableInstallation } from '../src/recovery/durable-restore.mjs';
import { restoreDurableData } from '../src/recovery/durable-restore-data.mjs';
import { readDurableRetirementPlan } from '../src/runtime/durable-retirement-plan.mjs';
import { retirementReview } from '../src/recovery/retirement-review.mjs';
import { retireDurableRoutes } from '../src/runtime/durable-restoration.mjs';
import { enrollDurableRestoration } from '../src/runtime/durable-installation.mjs';
import { assertDurableEnrollmentReady, beginDurableEnrollment } from '../src/runtime/enrollment-record.mjs';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';
import { readRuntimePolicy } from '../../platform/src/runtime-policy-file.mjs';
import { readRouteRecord } from '../../platform/src/route-record-store.mjs';
import { Controller } from '../../platform/src/controller.mjs';
import { sourceBundle } from './fixtures/durable-recovery.mjs';
import { durableEnrollmentFixture } from './fixtures/durable-enrollment.mjs';
import { durableDataTransport, gnuTar } from './fixtures/durable-data-transport.mjs';

const skip = gnuTar ? false : 'host GNU tar unavailable';
const id = '10000000-0000-4000-8000-000000000001';
async function fixture(t) {
  const source = await sourceBundle(t, ['alpha', 'beta']), p = source.policy;
  // Synthetic family for component execution: transport runs the real fixed
  // filesystem helpers. No image, native process or Docker mount is qualified.
  const entry = { ...runtimeFamilies()[0], schema: 2, routing: 'durable', id: p.family, admission: p.admission,
    image: p.image, storageImage: p.storageImage, binarySha256: p.binarySha256, supervisorSha256: p.supervisorSha256 };
  entry.sourceFiles['packages/platform/src/import-retired-routes.mjs'] = 'a'.repeat(64);
  const choose = { choose: () => entry }, selection = { expectedIdentity: runtimePolicyIdentity(p) };
  const retirement = { app: 'alpha', digest: source.request.digest, id, at: '2026-10-24T00:00:00.000Z', stopQueuedWork: false, stopScheduledWork: false };
  const plan = await readDurableRetirementPlan(source.dir, 'retired', selection, retirement, choose);
  const target = await durableEnrollmentFixture(t, { ...plan.target, entry });
  const volumePaths = Object.fromEntries(Object.keys(plan.target.config.volumes).map(role => [role, target.rolePath(role)]));
  const calls = [], transport = durableDataTransport(plan.target.config, plan.target.policy, volumePaths, calls);
  const sourceHost = join(source.root, 'host'); await mkdir(sourceHost, { mode: 0o700 });
  let live = false;
  const options = {
    plan: (directory, project, selected) => readDurableRetirementPlan(directory, project, selected, retirement, choose),
    verify: async () => {}, enrolled: async () => true, directory: () => sourceHost, related: async () => {},
    stopped: async () => { if (live) throw new Error('source writer appeared'); }, relation: async () => {},
    enroll: (selected, tasks) => enrollDurableRestoration(selected, tasks, target.options),
    data: (directory, config, policy, restore) => restoreDurableData(directory, config, policy, { ...restore, readVolume: transport }),
    routes: (config, input) => retireDurableRoutes(config, input, { run: target.options.run }),
    policy: (_image, _volume, env) => readRuntimePolicy(target.rolePath('runtime-policy'), env),
  };
  const output = join(source.root, 'retired-output');
  return { source, entry, target, retirement, selection, plan, options, calls, output, sourceHost, transport,
    sourceRunning: () => { live = true; }, run: () => retireDurableInstallation(source.dir, 'retired', output, selection, retirement, options) };
}
const uncertain = work => assert.rejects(work, error => error.code === 'DURABLE_RESTORE_UNCONFIRMED' && error.cause === undefined);

test('a matching reviewed retirement completes the existing fenced coordinator', { skip }, async t => {
  const f = await fixture(t);
  f.retirement.expectedPlan = retirementReview(f.plan).plan;
  await f.run();
  await assertDurableEnrollmentReady(f.target.directory);
  const state = JSON.parse(await readFile(join(f.target.rolePath('controller'), 'state.json')));
  assert.equal(state.apps.alpha.route, 'retired'); assert.equal(state.apps.alpha.slot, null);
  assert.equal(state.apps.beta.active, f.source.requests.beta.id);
});

test('a mismatched retirement review refuses before any target transport or output', { skip }, async t => {
  const f = await fixture(t); f.retirement.expectedPlan = '0'.repeat(64);
  await uncertain(f.run());
  assert.deepEqual(f.target.events, []); assert.deepEqual(f.calls, []);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
  assert.equal((await readdir(f.sourceHost)).includes('launch.pending.json'), false);
});

test('durable retirement preserves original recovery bytes, survivor files and pinned artifacts while emptying only the retired fleet', { skip }, async t => {
  const f = await fixture(t), before = await readFile(join(f.source.dir, 'manifest.json'));
  const result = await f.run();
  assert.equal(result.config.name, 'retired');
  assert.notEqual(runtimePolicyIdentity(result.policy), f.selection.expectedIdentity);
  assert.deepEqual(result.policy.fleets[1], f.source.policy.fleets[1]);
  assert.equal(result.policy.fleets[0].prefix, `retirement-generations/${id}`);
  assert.deepEqual(result.policy.fleets[0].nodes.map(node => node.id), [`slot-1-a-${id}`, `slot-1-b-${id}`]);
  await assertDurableEnrollmentReady(f.target.directory);
  assert.deepEqual(await readFile(join(f.source.dir, 'manifest.json')), before);
  assert.deepEqual(await readdir(f.target.rolePath('slot-1-a')), []);
  assert.deepEqual(await readdir(f.target.rolePath('slot-1-b')), []);
  assert.deepEqual(await readFile(join(f.target.rolePath('slot-2-a'), 'state.json')), await readFile(join(f.source.root, 'staging/state.json')));
  assert.deepEqual(await readFile(join(f.target.rolePath('bucket'), 'state.json')), await readFile(join(f.source.root, 'staging/state.json')));
  const state = JSON.parse(await readFile(join(f.target.rolePath('controller'), 'state.json')));
  assert.equal(state.apps.alpha.route, 'retired'); assert.equal(state.apps.alpha.slot, null);
  assert.equal(state.apps.beta.route, 'paused'); assert.equal(state.apps.beta.active, f.source.requests.beta.id);
  assert.deepEqual(state.artifactPins, f.source.c.state.artifactPins);
  assert.equal(await artifactDigest(join(f.target.rolePath('controller'), 'artifacts', f.source.request.id)), f.source.request.digest);
  assert.equal(await readFile(join(f.target.rolePath('controller'), 'operator-secret.key'), 'utf8'), 'source-private-value');
  const observed = await readRouteRecord(join(f.target.rolePath('route-authority'), 'routes.json'), { installation: runtimePolicyIdentity(result.policy), slots: ['slot-1', 'slot-2'] });
  assert.deepEqual(observed.record.routes, [{ host: 'beta.localhost', state: 'withheld', slot: 'slot-2' }]);
  assert.deepEqual(state.routeAuthority.holds, { beta: { id: f.source.requests.beta.id, digest: f.source.requests.beta.digest } });
  assert.deepEqual(JSON.parse(await readFile(join(f.output, 'retirement.json'))), f.plan.retirement.evidence);
  assert.equal(JSON.parse(await readFile(join(f.output, 'restored.json'))).enrollmentRequired, true);
  assert.equal((await readdir(f.sourceHost)).includes('launch.pending.json'), false);
  assert.ok(f.target.events.every(args => !args.some(value => ['start', 'up', 'rm', 'pull', 'build'].includes(value))));
});

test('a restored retirement controller rejects the old name and approves a differently named replacement in its fresh namespace', { skip }, async t => {
  const f = await fixture(t); await f.run();
  const slots = f.plan.target.policy.fleets.map(fleet => ({ ...fleet, nodes: fleet.nodes.map(node => node.host) }));
  const owners = { 'slot-2': { app: 'beta' } }, claimed = [];
  const backend = { owner: async slot => owners[slot.id] || null, hasDeployment: async () => false, assertUnclaimed: async () => {},
    claim: async (slot, app) => { owners[slot.id] = { app }; claimed.push(slot.prefix); },
    publish: async () => 'replacement-version', ready: async () => {}, applicationReady: async () => {}, migrate: async () => {}, applied: async () => [] };
  const c = new Controller({ dir: f.target.rolePath('controller'), slots, backend,
    routeAuthority: { path: join(f.target.rolePath('route-authority'), 'routes.json'),
      policy: { installation: runtimePolicyIdentity(f.plan.target.policy), slots: ['slot-1', 'slot-2'] }, verifyRuntime: async () => {} } });
  await c.init();
  await assert.rejects(c.mutate(f.source.request.id, f.source.request.digest, 'approve'), /retired/);
  const replacementId = '30000000-0000-4000-8000-000000000001', artifact = c.artifact(replacementId);
  await cp(f.source.c.artifact(f.source.request.id), artifact, { recursive: true });
  await writeFile(join(artifact, 'wrangler.json'), JSON.stringify({ name: 'gamma', main: 'index.js', d1_databases: [] }));
  const digest = await artifactDigest(artifact);
  c.state.deployments[replacementId] = { ...f.source.request, id: replacementId, app: 'gamma', resources: { ...f.source.request.resources, script: 'gamma' }, digest, status: 'pending', step: 'submitted' }; await c.save();
  await c.mutate(replacementId, digest, 'approve');
  assert.equal(c.state.apps.gamma.slot, 'slot-1'); assert.equal(c.state.apps.gamma.route, 'active');
  assert.deepEqual(claimed, [`retirement-generations/${id}`]);
  assert.equal(c.state.apps.beta.route, 'paused'); assert.equal(c.state.apps.alpha.route, 'retired');
});

for (const failure of ['source-live', 'changed-snapshot', 'copy-failed']) test(`${failure} retains an incomplete destination without spending route restoration`, { skip }, async t => {
  const f = await fixture(t), data = f.options.data;
  f.options.data = async (...args) => {
    await data(...args);
    if (failure === 'source-live') f.sourceRunning();
    if (failure === 'changed-snapshot') await writeFile(join(f.source.dir, 'controller.tar'), 'corrupted after copy');
    if (failure === 'copy-failed') throw new Error('lost copy receipt');
  };
  await uncertain(f.run());
  await assert.rejects(assertDurableEnrollmentReady(f.target.directory), { code: 'ENROLLMENT_NOT_READY' });
  await assert.rejects(lstat(join(f.target.rolePath('route-enrollment'), 'route-restoration.spent.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.target.rolePath('controller'), 'operator-secret.key'), 'utf8'), 'source-private-value');
  assert.deepEqual(await readdir(f.target.rolePath('slot-1-a')), []);
});

test('retirement output cannot authorize startup after host completion fails', { skip }, async t => {
  const f = await fixture(t);
  f.target.options.begin = async (...args) => { await beginDurableEnrollment(...args); return { complete: async () => { throw new Error('completion failed'); } }; };
  await uncertain(f.run());
  await assert.rejects(assertDurableEnrollmentReady(f.target.directory), { code: 'ENROLLMENT_NOT_READY' });
  assert.equal(JSON.parse(await readFile(join(f.output, 'retirement.json'))).app, 'alpha');
  assert.equal(JSON.parse(await readFile(join(f.output, 'restored.json'))).enrollmentRequired, true);
});

test('a runtime without the retirement helper refuses before output or target allocation', { skip }, async t => {
  const f = await fixture(t);
  delete f.entry.sourceFiles['packages/platform/src/import-retired-routes.mjs'];
  await uncertain(f.run());
  assert.deepEqual(f.target.events, []);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});

test('a retired replica disk changed during copying prevents route restoration and host completion', { skip }, async t => {
  const f = await fixture(t);
  const readVolume = async (...args) => {
    const output = await f.transport(...args);
    if (args[2][3] === 'compare-controller') await writeFile(join(f.target.rolePath('slot-1-a'), 'unexpected'), 'concurrent data');
    return output;
  };
  f.options.data = (directory, config, policy, restore) => restoreDurableData(directory, config, policy, { ...restore, readVolume });
  await uncertain(f.run());
  await assert.rejects(assertDurableEnrollmentReady(f.target.directory), { code: 'ENROLLMENT_NOT_READY' });
  await assert.rejects(lstat(join(f.target.rolePath('route-enrollment'), 'route-restoration.spent.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.target.rolePath('slot-1-a'), 'unexpected'), 'utf8'), 'concurrent data');
});
