import test from 'node:test';
import assert from 'node:assert/strict';
import { supportedController, supportedControllerView } from '../src/controller-schema.mjs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decisionHistoryCapability } from '@fogd/platform/decision-history';
import { backgroundBackupApps, prepareBackgroundBackup, backgroundSnapshotEvidence } from '../src/recovery/background-backup.mjs';
import { restoredInstallationState } from '../src/recovery/background-restore.mjs';
import { assertQueueFreeRecovery } from '../src/recovery/queue-safety.mjs';
import { requiredCapabilities } from '../src/recovery/restore.mjs';
import { execute } from '../src/recovery/execute.mjs';
import { cronSnapshotSource } from './fixtures/cron-snapshot.mjs';

function history(state = { apps: {}, deployments: {} }, outcome = 'succeeded') {
  let request = Object.values(state.deployments)[0];
  if (!request) {
    request = { id: randomUUID(), app: 'example', digest: 'a'.repeat(64), status: 'rejected', resources: {} };
    state.deployments[request.id] = request;
  }
  const at = new Date().toISOString();
  state.requirements = [...(state.requirements || []), decisionHistoryCapability];
  state.decisions = [{ id: randomUUID(), at, actor: { kind: 'basic', name: 'administrator' }, deployment: request.id,
    app: request.app, digest: request.digest, action: 'reject', secretRevision: null, review: null, outcome,
    completedAt: ['started', 'unconfirmed'].includes(outcome) ? null : at, applicationStatus: request.status }];
  return state;
}
async function archive(t, state, manifest = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-decision-recovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await execute('tar', ['-cf', join(dir, 'controller.tar'), '-C', dir, './state.json']);
  return dir;
}

test('decision history permits full backup and queue-free recovery without changing the source', () => {
  const state = history(), before = structuredClone(state);
  assert.deepEqual(backgroundBackupApps(state), { queueRecovery: [], cronRecovery: [] });
  assert.doesNotThrow(() => assertQueueFreeRecovery(state));
  assert.deepEqual(state, before);
});

for (const outcome of ['succeeded', 'started', 'unconfirmed']) test(`stopped restore retains ${outcome} decisions and requires a matching runtime`, async t => {
  const state = history(undefined, outcome), dir = await archive(t, state);
  const restored = await restoredInstallationState(dir, {});
  assert.deepEqual(restored, state);
  assert.notEqual(restored, state);
  assert.deepEqual(requiredCapabilities(restored), [['decision-history', 'decisionHistoryCapability', decisionHistoryCapability]]);
});

test('background restore retains decision identities while deriving a separate recovery hold', async t => {
  const { state, expected } = cronSnapshotSource(); history(state);
  const manifest = backgroundSnapshotEvidence(state, expected), dir = await archive(t, state, manifest);
  const restored = await restoredInstallationState(dir, manifest);
  assert.deepEqual(restored.decisions, state.decisions);
  assert.equal(restored.apps.refresh.cronRecovery.status, 'pending');
  assert.equal(restored.apps.refresh.route, 'paused');
  assert.equal(requiredCapabilities(restored)[0][2], decisionHistoryCapability);
});

for (const [name, mutate] of [
  ['missing history', state => { delete state.decisions; }],
  ['missing capability', state => { state.requirements = []; }],
  ['duplicate identities', state => { state.decisions.push(structuredClone(state.decisions[0])); }],
  ['wrong artifact', state => { state.decisions[0].digest = 'b'.repeat(64); }],
  ['unknown principal kind', state => { state.decisions[0].actor.kind = 'caller-claimed'; }],
  ['invalid outcome', state => { state.decisions[0].outcome = 'probably-succeeded'; }],
]) test(`${name} refuses before snapshot preparation or transformation`, async () => {
  const state = history(); mutate(state);
  await assert.rejects(prepareBackgroundBackup({}, state, {}, []), /decision history/i);
  assert.throws(() => assertQueueFreeRecovery(state), /decision history/i);
});

test('unknown capabilities remain refused alongside valid history', () => {
  const state = history(); state.requirements.push('future-platform-v2');
  assert.throws(() => backgroundBackupApps(state), /unsupported recovery capability/);
  assert.throws(() => assertQueueFreeRecovery(state), /unsupported recovery capability/);
});

test('expansion retains history and still requires the supporting runtime', async t => {
  const state = history(), dir = await archive(t, state);
  assert.deepEqual(await restoredInstallationState(dir, {}, { kind: 'expansion' }), state);
});

for (const replace of [undefined, []]) test(`retirement cannot erase saved history (${String(replace)})`, async t => {
  const state = history(), dir = await archive(t, state), changed = structuredClone(state);
  if (replace === undefined) { delete changed.decisions; changed.requirements = []; }
  else changed.decisions = replace;
  await assert.rejects(restoredInstallationState(dir, {}, { kind: 'retirement', state: changed }), /retain decision history/);
});

test('owner diagnostics accept validated private history and the authenticated count summary', () => {
  const state = history(), { decisions, ...view } = state;
  assert.equal(supportedController(state), true);
  assert.equal(supportedControllerView({ ...view, decisionHistory: { count: 1, unconfirmed: 0 } }), true);
  assert.equal(supportedController(view), false);
  assert.equal(supportedControllerView(view), false);
  decisions[0].digest = 'b'.repeat(64);
  assert.equal(supportedController(state), false);
});

for (const summary of [{ count: -1, unconfirmed: 0 }, { count: 1, unconfirmed: 2 }, { count: 1.5, unconfirmed: 0 }, { count: 1, unconfirmed: 0, extra: true }]) {
  test(`unsupported decision summary remains uncertain: ${JSON.stringify(summary)}`, () => {
    const { decisions: _decisions, ...view } = history();
    assert.equal(supportedControllerView({ ...view, decisionHistory: summary }), false);
  });
}
