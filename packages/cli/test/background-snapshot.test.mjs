import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cronSnapshotSource } from './fixtures/cron-snapshot.mjs';
import { config, services, volumes } from './fixtures/recovery-layout.mjs';
import { backgroundBackupApps, prepareBackgroundBackup, backgroundSnapshotEvidence, validateBackgroundEvidence } from '../src/recovery/background-backup.mjs';
import { restoredInstallationState } from '../src/recovery/background-restore.mjs';
import { assertQueueFreeRecovery } from '../src/recovery/queue-safety.mjs';
import { queueBackupApps } from '../src/recovery/queue-backup.mjs';
import { fingerprint } from '../src/recovery/bundle.mjs';
import { execute } from '../src/recovery/execute.mjs';
import { queueRetentionContract, queueExpiry } from '@fogd/platform/queue-snapshot';
import { requiredCapabilities } from '../src/recovery/restore.mjs';

async function archive(t, state, manifest) {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-background-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await execute('tar', ['-cf', join(dir, 'controller.tar'), '-C', dir, './state.json']);
  return dir;
}
function addQueue(state, expected) {
  const deployment = randomUUID(), at = Date.now(), version = 'queue-version';
  const observation = { paused: true, stored: 1, backlogCount: 1, backlogBytes: 10, oldestMessageTimestamp: at - 1000 };
  const receipt = { schema: 1, id: randomUUID(), deployment, digest: 'd'.repeat(64), version, queue: 'jobs', slot: 'one', at, completedAt: at, observation, contract: queueRetentionContract, expiresAt: queueExpiry(observation, at) };
  state.requirements.push('fogd-queue-activation-v1');
  state.apps.imports = { active: deployment, slot: 'one', route: 'active', resources: { queues: {} }, queueBootstrap: { phase: 'application' }, delivery: { queue: 'jobs', desired: 'paused', observed: 'paused', hold: null, operation: null, version }, queueSnapshot: receipt };
  state.deployments[deployment] = { id: deployment, app: 'imports', status: 'active', digest: receipt.digest, version, resources: { queues: {} } };
  expected.queueRecovery.imports = receipt.id;
}

test('full snapshots account for separate queue and cron apps and retain independent recovery contracts', async t => {
  const { state, expected } = cronSnapshotSource(); addQueue(state, expected);
  state.apps.static = { active: 'static-release', slot: 'three', route: 'active', resources: {} };
  state.deployments['static-release'] = { app: 'static', status: 'active', resources: {} };
  const before = structuredClone(state), manifest = backgroundSnapshotEvidence(state, expected);
  assert.deepEqual(backgroundBackupApps(state), { queueRecovery: ['imports'], cronRecovery: ['refresh'] });
  assert.equal(manifest.cronRecovery.apps.refresh.observation.nextAlarm, null);
  assert.equal(manifest.queueRecovery.apps.imports.expiresAt, state.apps.imports.queueSnapshot.expiresAt);
  assert.deepEqual(validateBackgroundEvidence(state, manifest), backgroundBackupApps(state));
  const dir = await archive(t, state, manifest), restored = await restoredInstallationState(dir, manifest);
  for (const [name, field] of [['imports', 'queueRecovery'], ['refresh', 'cronRecovery']]) {
    assert.equal(restored.apps[name].route, 'paused');
    assert.equal(restored.apps[name][field].status, 'pending');
    assert.equal(restored.apps[name][field].snapshot, (await fingerprint(join(dir, 'manifest.json'))).sha256);
  }
  assert.equal(restored.apps.refresh.dispatch.desired, 'paused');
  assert.equal(restored.apps.refresh.cronSnapshot, undefined);
  assert.equal(restored.apps.imports.queueSnapshot, undefined);
  assert.deepEqual(restored.apps.static, state.apps.static);
  assert.deepEqual(restored.deployments, state.deployments);
  assert.deepEqual(state, before);
  const again = await restoredInstallationState(dir, manifest);
  assert.notEqual(restored.apps.refresh.cronRecovery.id, again.apps.refresh.cronRecovery.id);
  assert.notEqual(restored.apps.imports.queueRecovery.id, again.apps.imports.queueRecovery.id);
  assert.deepEqual(requiredCapabilities(restored).map(value => value[0]), ['queue-snapshot', 'cron-dispatch', 'cron-snapshot']);
});

test('cron evidence pins approval, selected secrets, schedule and native revision through shutdown', () => {
  const { state, expected } = cronSnapshotSource();
  for (const mutate of [
    value => { value.apps.refresh.cronSnapshot.deployment = randomUUID(); },
    value => { value.apps.refresh.cronSnapshot.digest = 'a'.repeat(64); },
    value => { value.apps.refresh.cronSnapshot.version = 'other'; },
    value => { value.apps.refresh.cronSnapshot.secretRevision = randomUUID(); },
    value => { value.apps.refresh.cronSnapshot.observation.revision++; },
    value => { value.apps.refresh.dispatch.desired = 'running'; },
    value => { value.apps.refresh.dispatch.operation = 'pause'; },
    value => { value.apps.refresh.route = 'paused'; },
    value => { value.apps.refresh.resources.crons = ['*/2 * * * *']; },
    value => { value.apps.refresh.cronSnapshot = null; },
    value => { value.apps.refresh.cronRecovery = { status: 'pending' }; },
  ]) {
    const changed = structuredClone(state); mutate(changed);
    assert.throws(() => backgroundSnapshotEvidence(changed, expected));
  }
  assert.throws(() => backgroundSnapshotEvidence(state, { ...expected, cronRecovery: {} }), /inventory changed/);
  assert.throws(() => backgroundSnapshotEvidence(state, { ...expected, cronRecovery: { refresh: randomUUID() } }), /preparation changed/);
});

test('legacy, missing, extra and mismatched evidence fail before creating restored recovery metadata', async t => {
  const { state, expected } = cronSnapshotSource(), manifest = backgroundSnapshotEvidence(state, expected);
  const dir = await archive(t, state, manifest);
  await assert.rejects(restoredInstallationState(dir, {}), /legacy scheduled/);
  for (const mutate of [
    value => { value.cronRecovery.apps.refresh.version = 'other'; },
    value => { value.cronRecovery.apps.refresh = null; },
    value => { value.cronRecovery.apps.extra = value.cronRecovery.apps.refresh; },
    value => { value.queueRecovery = { schema: 1, apps: {} }; },
  ]) {
    const changed = structuredClone(manifest); mutate(changed);
    await assert.rejects(restoredInstallationState(dir, changed));
  }
  assert.equal(state.apps.refresh.cronRecovery, undefined);
});

test('expired queue evidence also blocks a combined restore before either family receives acknowledgment authority', async t => {
  const { state, expected } = cronSnapshotSource(); addQueue(state, expected);
  const manifest = backgroundSnapshotEvidence(state, expected), dir = await archive(t, state, manifest);
  await assert.rejects(restoredInstallationState(dir, manifest, null, state.apps.imports.queueSnapshot.expiresAt), /expired/);
  assert.equal(state.apps.refresh.cronRecovery, undefined);
});

test('scheduled history refuses expansion, unplanned retirement and queue-only recovery paths', async t => {
  const { state, expected } = cronSnapshotSource(), manifest = backgroundSnapshotEvidence(state, expected), dir = await archive(t, state, manifest);
  await assert.rejects(restoredInstallationState(dir, manifest, { kind: 'expansion' }), /not qualified for installation transformations/);
  await assert.rejects(restoredInstallationState(dir, manifest, { kind: 'retirement' }), /requires a validated retirement plan/);
  assert.throws(() => assertQueueFreeRecovery(state), /Scheduled history/);
  assert.throws(() => queueBackupApps(state), /Scheduled history/);
});

test('unknown or unaccounted background capabilities and incomplete approvals fail before any prepare request', async () => {
  const { state } = cronSnapshotSource();
  for (const mutate of [
    value => { value.requirements.push('future-runtime-v2'); },
    value => { value.requirements = []; },
    value => { value.requirements = ['fogd-cron-recovery-v1']; value.apps = {}; value.deployments = {}; },
    value => { value.requirements = ['fogd-queue-recovery-v1']; value.apps = {}; value.deployments = {}; },
    value => { value.apps = {}; },
    value => { delete value.apps.refresh.dispatch; },
    value => { value.deployments[value.apps.refresh.active].status = 'failed'; },
    value => { value.deployments[value.apps.refresh.active].resources.queues = {}; },
  ]) {
    const changed = structuredClone(state); mutate(changed);
    await assert.rejects(prepareBackgroundBackup({}, changed, {}, []));
  }
  await assert.rejects(prepareBackgroundBackup({}, state, { controller: 'a', replica: 'b' }, ['replica']), /identical pinned/);
});

test('artifact-only scheduled submissions preserve inert history without runtime preparation or recovery acknowledgment', async t => {
  const { state } = cronSnapshotSource(), request = state.deployments[state.apps.refresh.active];
  state.apps = {}; request.status = 'pending'; request.step = 'submitted';
  delete request.secretRevision; delete request.version;
  const expected = await prepareBackgroundBackup({}, state, {}, []);
  assert.deepEqual(expected, { queueRecovery: {}, cronRecovery: {} });
  assert.deepEqual(backgroundSnapshotEvidence(state, expected), {});
  const dir = await archive(t, state, {}), restored = await restoredInstallationState(dir, {});
  assert.deepEqual(restored, state);
  assert.deepEqual(requiredCapabilities(restored).map(value => value[0]), ['cron-dispatch']);
  request.secretRevision = null;
  assert.throws(() => backgroundBackupApps(state), /active app for every approved/);
});

test('checksummed legacy cron bundles are refused by the real CLI before Docker or target creation', async t => {
  const { state } = cronSnapshotSource(), dir = await archive(t, state, {}), files = {};
  for (const name of ['compose.json', 'images.tar', ...volumes.map(value => `${value}.tar`)]) {
    if (name !== 'controller.tar') await writeFile(join(dir, name), name === 'compose.json' ? JSON.stringify(config()) : 'unused');
    files[name] = await fingerprint(join(dir, name));
  }
  const manifest = { format: 'fogd-stopped-v1', sourceProject: 'original', files, images: Object.fromEntries(services.map(value => [value, 'sha256:' + 'a'.repeat(64)])) };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const target = join(dir, 'target');
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../bin/fogd.js', import.meta.url)), 'restore', dir, '--project', 'fresh', '--output', target], { env: { ...process.env, DOCKER_HOST: 'unix:///nonexistent-fogd-recovery-test.sock' } }), error => error.stderr.includes('legacy scheduled'));
  await assert.rejects(access(target), /ENOENT/);
});

test('preparation uses each authenticated control family and validates all inventories and images before contacting it', async t => {
  const { state } = cronSnapshotSource(), expected = { queueRecovery: {}, cronRecovery: {} }; addQueue(state, expected);
  const calls = [], credentials = `Basic ${Buffer.from('admin:password').toString('base64')}`;
  const http = createServer(async (request, response) => {
    const body = []; for await (const chunk of request) body.push(chunk);
    calls.push({ path: request.url, authorization: request.headers.authorization, csrf: request.headers['x-fogd-csrf'], body: body.length ? JSON.parse(Buffer.concat(body).toString()) : null });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(request.url === '/v1/admin' ? { csrf: 'session-token' } : { id: request.url.includes('/delivery/') ? 'queue-preparation' : 'cron-preparation' }));
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const env = { FOGD_SERVER: `http://127.0.0.1:${http.address().port}`, FOGD_ADMIN_PASSWORD: 'password' }, images = { controller: 'same', a: 'same', b: 'same' };
  const invalid = structuredClone(state); invalid.apps.refresh.dispatch.hold = 'unfinished-approval';
  await assert.rejects(prepareBackgroundBackup(env, invalid, images, ['a', 'b']), /reconciled dispatch/);
  await assert.rejects(prepareBackgroundBackup(env, state, { ...images, b: 'different' }, ['a', 'b']), /identical pinned/);
  assert.deepEqual(calls, []);
  const result = await prepareBackgroundBackup(env, state, images, ['a', 'b']);
  assert.deepEqual(result, { queueRecovery: { imports: 'queue-preparation' }, cronRecovery: { refresh: 'cron-preparation' } });
  assert.deepEqual(calls.map(value => value.path), ['/v1/admin', '/v1/apps/imports/delivery/snapshot', '/v1/admin', '/v1/apps/refresh/dispatch/snapshot']);
  assert.ok(calls.every(value => value.authorization === credentials));
  for (const [index, name] of [[1, 'imports'], [3, 'refresh']]) {
    const active = state.deployments[state.apps[name].active];
    assert.equal(calls[index].csrf, 'session-token');
    assert.deepEqual(calls[index].body, { deployment: active.id, digest: active.digest });
  }
});

test('the real restore CLI refuses inconsistent pinned cron images before Docker or target creation', async t => {
  const { state, expected } = cronSnapshotSource(), manifest = backgroundSnapshotEvidence(state, expected), dir = await archive(t, state, manifest), files = {};
  for (const name of ['compose.json', 'images.tar', ...volumes.map(value => `${value}.tar`)]) {
    if (name !== 'controller.tar') await writeFile(join(dir, name), name === 'compose.json' ? JSON.stringify(config()) : 'unused');
    files[name] = await fingerprint(join(dir, name));
  }
  Object.assign(manifest, { format: 'fogd-stopped-v1', sourceProject: 'original', files, images: Object.fromEntries(services.map(value => [value, 'sha256:' + 'a'.repeat(64)])) });
  manifest.images['slot-2-b'] = 'sha256:' + 'b'.repeat(64);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const target = join(dir, 'target');
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../bin/fogd.js', import.meta.url)), 'restore', dir, '--project', 'fresh', '--output', target], { env: { ...process.env, DOCKER_HOST: 'unix:///nonexistent-fogd-recovery-test.sock' } }), error => error.stderr.includes('identical pinned'));
  await assert.rejects(access(target), /ENOENT/);
});

test('queue-free topology paths reject unmarked cron declarations and orphan lifecycle metadata', () => {
  for (const field of ['dispatch', 'cronBootstrap', 'cronSnapshot', 'cronRecovery', 'dispatchRecoveryError']) {
    const state = { apps: { orphan: { [field]: null } }, deployments: {} };
    assert.throws(() => assertQueueFreeRecovery(state), /Scheduled history/);
  }
  assert.throws(() => assertQueueFreeRecovery({ apps: {}, deployments: { submitted: { resources: { crons: [] } } } }), /Scheduled history/);
});
