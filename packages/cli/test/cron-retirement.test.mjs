import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cronSnapshotSource } from './fixtures/cron-snapshot.mjs';
import { config, volumes, services } from './fixtures/recovery-layout.mjs';
import { fingerprint } from '../src/recovery/bundle.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { retireState, validateRetirementState } from '@fogd/platform/retirement';
import { validateCronState } from '../../platform/src/cron-activation.mjs';
import { backgroundBackupApps, backgroundSnapshotEvidence, validateBackgroundEvidence } from '../src/recovery/background-backup.mjs';
import { restoredInstallationState } from '../src/recovery/background-restore.mjs';
import { planRetirement } from '../src/recovery/retirement-plan.mjs';
import { requiredCapabilities } from '../src/recovery/restore.mjs';
import { assertQueueFreeRecovery } from '../src/recovery/queue-safety.mjs';
import { execute } from '../src/recovery/execute.mjs';
import { queueRetentionContract, queueExpiry } from '@fogd/platform/queue-snapshot';

const evidence = { previous: { slot: 'two', prefix: 'old/refresh' }, replacement: { prefix: 'fresh/refresh' }, snapshot: { sha256: 'b'.repeat(64) } };
function retiredSource() {
  const { state } = cronSnapshotSource(), digest = state.deployments[state.apps.refresh.active].digest;
  return { state, digest, retired: retireState(state, 'refresh', digest, evidence, { stopScheduledWork: true }) };
}
async function archive(t, state, manifest) {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-cron-retirement-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await execute('tar', ['-cf', join(dir, 'controller.tar'), '-C', dir, './state.json']);
  return dir;
}

function addQueue(state, expected) {
  const deployment = randomUUID(), at = Date.now(), version = 'queue-version';
  const resources = { queues: { producers: [{ queue: 'jobs' }], consumers: [{ queue: 'jobs' }] } };
  const observation = { paused: true, stored: 1, backlogCount: 1, backlogBytes: 10, oldestMessageTimestamp: at - 1000 };
  const receipt = { schema: 1, id: randomUUID(), deployment, digest: 'd'.repeat(64), version, queue: 'jobs', slot: 'one', at, completedAt: at, observation, contract: queueRetentionContract, expiresAt: queueExpiry(observation, at) };
  state.requirements.push('fogd-queue-activation-v1');
  state.apps.imports = { active: deployment, slot: 'one', route: 'active', resources, queueBootstrap: { phase: 'application' },
    delivery: { schema: 1, observedAt: new Date(at).toISOString(), queue: 'jobs', desired: 'paused', observed: 'paused', hold: null, operation: null, version }, queueSnapshot: receipt };
  state.deployments[deployment] = { id: deployment, app: 'imports', status: 'active', digest: receipt.digest, version, resources };
  expected.queueRecovery.imports = receipt.id;
}

test('cron retirement requires explicit stopped work and an exact completed snapshot before changing state', () => {
  const { state } = cronSnapshotSource(), digest = state.deployments[state.apps.refresh.active].digest, before = structuredClone(state);
  assert.throws(() => retireState(state, 'refresh', digest, evidence), /stop-scheduled-work/);
  assert.throws(() => retireState(state, 'refresh', digest, evidence, { stopScheduledWork: true, stopQueuedWork: true }), /requires a queued app/);
  for (const [change, expected] of [
    [app => { app.dispatch.operation = 'pause'; }, /unfinished cron operation/],
    [app => { app.dispatch.desired = 'running'; }, /confirmed operator pause/],
    [app => { app.cronSnapshot.version = 'different'; }, /differs from its exact approval/],
    [app => { app.cronSnapshot.secretRevision = randomUUID(); }, /differs from its exact approval/],
    [app => { app.cronRecovery = { status: 'pending' }; }, /Acknowledge restored cron recovery/],
    [app => { app.uncertain = 'uncertain'; }, /requires reconciled dispatch/],
    [app => { app.cronBootstrap.phase = 'pending'; }, /requires reconciled dispatch/],
    [app => { app.dispatch.hold = 'hold'; }, /requires reconciled dispatch/],
    [app => { app.route = 'paused'; }, /confirmed operator pause/],
    [app => { app.dispatchRecoveryError = 'unconfirmed'; }, /Reconcile cron dispatch recovery/],
    [app => { app.quarantined = true; }, /requires reconciled dispatch/],
    [app => { app.resources = { ...app.resources, crons: ['*/2 * * * *'] }; }, /declaration differs from approval/],
  ]) {
    const changed = structuredClone(state); change(changed.apps.refresh);
    assert.throws(() => retireState(changed, 'refresh', digest, evidence, { stopScheduledWork: true }), expected);
  }
  const ordinary = { apps: { static: { slot: 'one', active: 'active', route: 'active' } }, deployments: { active: { app: 'static', status: 'active', digest } } };
  assert.throws(() => retireState(ordinary, 'static', digest, evidence, { stopScheduledWork: true }), /requires a scheduled app/);
  const interrupted = structuredClone(state); interrupted.deployments.interrupted = { app: 'refresh', status: 'activating' };
  assert.throws(() => retireState(interrupted, 'refresh', digest, evidence, { stopScheduledWork: true }), /interrupted activation/);
  assert.deepEqual(state, before);
});

test('the real retirement CLI parses scheduled acknowledgment and refuses mismatched bundle evidence before Docker or target creation', async t => {
  const { state, expected } = cronSnapshotSource(), active = state.deployments[state.apps.refresh.active];
  const manifest = backgroundSnapshotEvidence(state, expected), dir = await archive(t, state, manifest), files = {};
  for (const name of ['compose.json', 'images.tar', ...volumes.map(value => `${value}.tar`)]) {
    if (name !== 'controller.tar') await writeFile(join(dir, name), name === 'compose.json' ? JSON.stringify(config()) : 'unused');
    files[name] = await fingerprint(join(dir, name));
  }
  Object.assign(manifest, { format: 'fogd-stopped-v1', sourceProject: 'original', files, images: Object.fromEntries(services.map(value => [value, 'sha256:' + 'a'.repeat(64)])) });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const output = join(dir, 'target');
  const invoke = (digest, flags = []) => promisify(execFile)(process.execPath, [fileURLToPath(new URL('../bin/fogd.js', import.meta.url)), 'retire', dir, '--app', 'refresh', '--digest', digest, '--project', 'fresh', '--output', output, ...flags], { env: { ...process.env, DOCKER_HOST: 'unix:///nonexistent-fogd-retirement-test.sock' } });
  await assert.rejects(invoke(active.digest), error => error.stderr.includes('requires --stop-scheduled-work'));
  await assert.rejects(invoke('b'.repeat(64), ['--stop-scheduled-work']), error => error.stderr.includes('active artifact digest mismatch'));
  manifest.cronRecovery.apps.refresh.version = 'different-version';
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(invoke(active.digest, ['--stop-scheduled-work']), error => error.stderr.includes('Cron snapshot evidence differs from archived controller metadata'));
  await assert.rejects(access(output), /ENOENT/);
});

test('retired cron history has no operational journal, requires a valid audit and cannot revive approved declarations', () => {
  const { state, retired } = retiredSource(), audit = retired.apps.refresh.retirement.cron;
  assert.deepEqual(audit.dispatch, state.apps.refresh.dispatch);
  assert.deepEqual(audit.prepared, state.apps.refresh.cronSnapshot);
  validateRetirementState(retired, [{ prefix: 'fresh/refresh' }]);
  validateCronState(retired, undefined);
  assert.deepEqual(backgroundBackupApps(retired), { queueRecovery: [], cronRecovery: [] });
  for (const field of ['dispatch', 'cronBootstrap', 'cronSnapshot', 'cronRecovery', 'dispatchRecoveryError']) {
    assert.equal(Object.hasOwn(retired.apps.refresh, field), false);
    const changed = structuredClone(retired); changed.apps.refresh[field] = null;
    assert.throws(() => backgroundBackupApps(changed), /operational/);
  }
  for (const [change, expected] of [
    [value => { delete value.apps.refresh.retirement.cron; }, /stopped-work audit/],
    [value => { value.requirements = value.requirements.filter(item => item !== 'fogd-cron-retirement-v1'); }, /stopped-work audit/],
    [value => { value.apps.refresh.retirement.cron.prepared.secretRevision = randomUUID(); }, /preparation differs from its approval/],
    [value => { value.apps.refresh.retirement.cron.prepared.crons = ['*/2 * * * *']; }, /Invalid pre-pause cron observation/],
    [value => { value.apps.refresh.retirement.cron.dispatch.desired = 'running'; }, /completed paused activation/],
    [value => { value.deployments[value.apps.refresh.active].status = 'active'; }, /retired approval/],
    [value => { value.apps.refresh.retirement.snapshot.sha256 = 'bad'; }, /matching dispatch and snapshot evidence/],
  ]) {
    const changed = structuredClone(retired); change(changed);
    assert.throws(() => backgroundBackupApps(changed), expected);
  }
  const ordinary = { apps: { static: { slot: null, route: 'retired', retirement: { previous: { prefix: 'old/static' } }, cronSnapshot: {} } }, deployments: {} };
  assert.throws(() => backgroundBackupApps(ordinary), /operational dispatch state/);
  assert.throws(() => assertQueueFreeRecovery(retired), /Scheduled history/);
});

test('a fresh retirement plan gives the replacement a disjoint prefix and new nodes while retaining old approval and secrets', () => {
  const { state } = cronSnapshotSource(), app = state.apps.refresh, active = state.deployments[app.active];
  app.slot = 'slot-2'; app.cronSnapshot.slot = 'slot-2';
  active.secretRevision = 'private-secret-revision'; app.cronSnapshot.secretRevision = active.secretRevision;
  const layout = config(), before = structuredClone(state);
  const plan = planRetirement(layout, state, 'refresh', active.digest, { stopScheduledWork: true, snapshot: evidence.snapshot });
  assert.deepEqual(state, before);
  assert.equal(plan.state.deployments[active.id].secretRevision, active.secretRevision);
  assert.deepEqual(plan.skipped, ['slot-2-a', 'slot-2-b']);
  assert.notEqual(plan.evidence.previous.prefix, plan.evidence.replacement.prefix);
  for (const name of plan.skipped) {
    assert.notEqual(plan.config.services[name].environment.CELLD_NODE, layout.services[name].environment.CELLD_NODE);
    assert.ok(plan.config.services[name].environment.CELLD_BUCKET.endsWith('/' + plan.evidence.replacement.prefix));
  }
  assert.equal(plan.state.apps.refresh.slot, null);
  assert.deepEqual(requiredCapabilities(plan.state, plan).map(item => item[0]), ['retirement', 'cron-dispatch', 'cron-retirement']);
});

test('retiring an ordinary app gates surviving crons and refuses expansion of the same snapshot', async t => {
  const { state, expected } = cronSnapshotSource(), manifest = backgroundSnapshotEvidence(state, expected);
  state.apps.static = { slot: 'one', active: 'static', route: 'active' };
  state.deployments.static = { app: 'static', status: 'active', digest: 'd'.repeat(64) };
  const dir = await archive(t, state, manifest);
  const change = { kind: 'retirement', state: retireState(state, 'static', 'd'.repeat(64), { ...evidence, previous: { slot: 'one', prefix: 'old/static' } }) };
  const restored = await restoredInstallationState(dir, manifest, change);
  assert.equal(restored.apps.refresh.cronRecovery.status, 'pending');
  assert.equal(restored.apps.refresh.route, 'paused');
  assert.equal(restored.apps.refresh.dispatch.desired, 'paused');
  assert.equal(restored.apps.static.route, 'retired');
  assert.equal(change.state.apps.refresh.cronRecovery, undefined);
  await assert.rejects(restoredInstallationState(dir, manifest, { kind: 'expansion' }), /not qualified/);
});

test('retirement drops only target recovery authority and zero-live cron archives restore without any live preparation', async t => {
  const { state, expected } = cronSnapshotSource(), active = state.deployments[state.apps.refresh.active];
  const manifest = backgroundSnapshotEvidence(state, expected), dir = await archive(t, state, manifest);
  const next = retireState(state, 'refresh', active.digest, evidence, { stopScheduledWork: true });
  const restored = await restoredInstallationState(dir, manifest, { kind: 'retirement', state: next });
  assert.deepEqual(restored, next);
  assert.deepEqual(backgroundSnapshotEvidence(restored, { queueRecovery: {}, cronRecovery: {} }), {});
  const zeroLive = await archive(t, restored, {});
  assert.deepEqual(await restoredInstallationState(zeroLive, {}), next);
  assert.deepEqual(validateBackgroundEvidence(next, {}), { queueRecovery: [], cronRecovery: [] });
  await assert.rejects(restoredInstallationState(zeroLive, manifest), /Unexpected cron/);
  assert.ok(requiredCapabilities(next).some(item => item[0] === 'cron-retirement'));
});

test('cron and queue retirements preserve both families of survivors and revalidate acknowledged cron recovery', async t => {
  const { state, expected } = cronSnapshotSource(); addQueue(state, expected);
  const other = cronSnapshotSource(), otherApp = other.state.apps.refresh, otherRequest = other.state.deployments[otherApp.active];
  otherRequest.app = 'survivor'; otherRequest.resources.script = 'survivor';
  otherApp.slot = 'three'; otherApp.dispatch.script = 'survivor'; otherApp.cronSnapshot.script = 'survivor'; otherApp.cronSnapshot.slot = 'three';
  state.apps.survivor = otherApp; state.deployments[otherRequest.id] = otherRequest; expected.cronRecovery.survivor = otherApp.cronSnapshot.id;
  const refresh = state.apps.refresh;
  state.requirements.push('fogd-cron-recovery-v1');
  refresh.cronRecovery = { id: randomUUID(), status: 'acknowledged', snapshot: 'f'.repeat(64), prepared: structuredClone(refresh.cronSnapshot) };
  const manifest = backgroundSnapshotEvidence(state, expected), dir = await archive(t, state, manifest);
  const retiredCron = retireState(state, 'refresh', state.deployments[refresh.active].digest, evidence, { stopScheduledWork: true });
  const target = await restoredInstallationState(dir, manifest, { kind: 'retirement', state: retiredCron });
  assert.equal(target.apps.refresh.route, 'retired');
  assert.equal(target.apps.refresh.cronRecovery, undefined);
  assert.equal(target.apps.imports.queueRecovery.status, 'pending');
  assert.equal(target.apps.survivor.cronRecovery.status, 'pending');
  assert.equal(target.apps.imports.route, 'paused'); assert.equal(target.apps.survivor.route, 'paused');
  validateRetirementState(target, [{ prefix: 'fresh/refresh' }]);
  const tampered = structuredClone(retiredCron);
  tampered.apps.refresh.retirement.cron.recovery.prepared.deployment = otherRequest.id;
  assert.throws(() => backgroundBackupApps(tampered), /does not identify an approval/);
  const queued = state.deployments[state.apps.imports.active];
  const retiredQueue = retireState(state, 'imports', queued.digest, { ...evidence, previous: { slot: 'one', prefix: 'old/imports' } }, { stopQueuedWork: true });
  const queueTarget = await restoredInstallationState(dir, manifest, { kind: 'retirement', state: retiredQueue });
  assert.equal(queueTarget.apps.imports.route, 'retired');
  assert.equal(queueTarget.apps.refresh.cronRecovery.status, 'pending');
  assert.equal(queueTarget.apps.survivor.cronRecovery.status, 'pending');
});
