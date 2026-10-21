import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { fixture } from './fixtures/cron-controller.mjs';
import { readJson, saveJson } from '../src/store.mjs';
import { operateDispatch, dispatchView } from '../src/admin-dispatch.mjs';
import { adminState } from '../src/admin-view.mjs';
import { cronRecoveryCapability, matchingCronSnapshot, validateCronSnapshot } from '../src/cron-snapshot.mjs';

async function prepared(t) {
  const f = await fixture(t), request = await f.request(f.c, { requiredSecrets: ['REFRESH_TOKEN'] });
  const secret = await f.c.replaceSecrets('refresh', { REFRESH_TOKEN: 'private-recovery-value' });
  await f.c.mutate(request.id, request.digest, 'approve', secret.revision);
  const input = { deployment: request.id, digest: request.digest };
  const operate = (controller, action, extra = {}) => controller.exclusive(() => operateDispatch(controller, 'refresh', action, { ...input, ...extra }));
  await operate(f.c, 'snapshot');
  return { ...f, input, operate, snapshot: structuredClone(f.c.state.apps.refresh.cronSnapshot) };
}
async function restore(f) {
  const app = f.c.state.apps.refresh;
  app.route = 'paused';
  app.cronRecovery = { id: randomUUID(), status: 'pending', snapshot: 'a'.repeat(64), prepared: structuredClone(f.snapshot) };
  f.c.state.requirements.push(cronRecoveryCapability);
  await f.c.save();
  const c = f.create(); await c.init(); return c;
}
const acceptance = c => {
  const recovery = dispatchView(c, 'refresh').recovery;
  return { recovery: recovery.id, review: recovery.review, acceptPossibleLoss: true };
};

test('snapshot binds exact artifact, secrets, schedule and confirmed pause; any dispatch operation invalidates it', async t => {
  const f = await prepared(t), app = f.c.state.apps.refresh;
  assert.equal(f.snapshot.beforePause.paused, false);
  assert.equal(f.snapshot.beforePause.nextAlarm, 60000);
  assert.equal(f.snapshot.observation.paused, true);
  assert.equal(f.snapshot.observation.nextAlarm, null);
  assert.equal(f.snapshot.observation.revision, f.snapshot.beforePause.revision + 1);
  assert.equal(matchingCronSnapshot(f.c.state, 'refresh', f.snapshot), app);
  assert.equal(f.c.route('refresh.localhost').state, 'active');
  const visible = JSON.stringify(adminState(f.c));
  assert.ok(!visible.includes(f.snapshot.version));
  assert.equal(adminState(f.c).apps.refresh.cronSnapshot, undefined);
  await f.operate(f.c, 'observe');
  assert.equal(app.cronSnapshot, undefined);
  await f.operate(f.c, 'snapshot');
  assert.equal(app.cronSnapshot.beforePause.paused, true);
  assert.equal(app.cronSnapshot.observation.revision, f.snapshot.observation.revision);
  await f.operate(f.c, 'resume');
  assert.equal(app.cronSnapshot, undefined);
});

test('snapshot verifies stored artifact and approval inputs before runtime mutation', async t => {
  const f = await prepared(t), before = (await f.runtime()).events.length;
  await assert.rejects(f.operate(f.c, 'snapshot', { digest: 'b'.repeat(64) }), /deployment\/digest changed/);
  await appendFile(join(f.c.artifact(f.input.deployment), 'worker/index.js'), '\n// changed');
  await assert.rejects(f.operate(f.c, 'snapshot'), /artifact digest mismatch/);
  assert.equal((await f.runtime()).events.length, before);
});

test('restored dispatch and routing stay held through acknowledgment; resume is a separate exact-artifact decision', async t => {
  const f = await prepared(t), c = await restore(f), app = c.state.apps.refresh;
  assert.equal(c.route('refresh.localhost').state, 'paused');
  assert.equal((await f.runtime()).paused, true);
  assert.equal(dispatchView(c, 'refresh').resumeAllowed, false);
  assert.equal(app.cronRecovery.checkError, null);
  const first = structuredClone(app.cronRecovery.firstObservation);
  await assert.rejects(f.operate(c, 'resume'), /completed activation/);
  const update = await f.request(c);
  await assert.rejects(c.mutate(update.id, update.digest, 'approve'), /Acknowledge restored cron recovery/);
  await c.mutate(update.id, update.digest, 'reject');
  for (const invalid of [{ recovery: randomUUID() }, { review: 'old' }, { acceptPossibleLoss: false }]) {
    await assert.rejects(f.operate(c, 'acknowledge-recovery', { ...acceptance(c), ...invalid }));
  }
  await f.operate(c, 'acknowledge-recovery', acceptance(c));
  assert.equal(c.route('refresh.localhost').state, 'active');
  assert.equal((await f.runtime()).paused, true);
  assert.deepEqual(app.cronRecovery.firstObservation, first);
  assert.equal(app.cronRecovery.status, 'acknowledged');
  await f.operate(c, 'resume');
  assert.equal((await f.runtime()).paused, false);
  assert.ok(!JSON.stringify(adminState(c)).includes(f.snapshot.version));
});

test('an unavailable restored runtime stays held and changed findings require a fresh review', async t => {
  const f = await prepared(t), snapshot = f.backend.crons.snapshot;
  f.backend.crons.snapshot = async () => { throw Error('private runtime credentials'); };
  const c = await restore(f), old = acceptance(c);
  assert.equal(c.route('refresh.localhost').state, 'paused');
  assert.match(c.state.apps.refresh.cronRecovery.checkError, /could not be confirmed/);
  assert.doesNotMatch(JSON.stringify(dispatchView(c, 'refresh')), /private runtime credentials/);
  f.backend.crons.snapshot = snapshot;
  await assert.rejects(f.operate(c, 'acknowledge-recovery', old), /findings changed/);
  assert.equal(c.state.apps.refresh.cronRecovery.status, 'pending');
  await f.operate(c, 'acknowledge-recovery', acceptance(c));
  assert.equal((await f.runtime()).paused, true);
});

test('an active restored timer is corrected but permanently refuses acknowledgment of that restore', async t => {
  const f = await prepared(t), path = join(f.dir, 'cron-runtime.json'), native = await readJson(path);
  // A lost hold followed by corrective pause can reach the expected revision.
  // The first active observation must remain disqualifying on every retry.
  native.paused = false; native.revision = f.snapshot.observation.revision - 1;
  await saveJson(path, native);
  const c = await restore(f);
  assert.equal((await f.runtime()).paused, true);
  assert.equal((await f.runtime()).revision, f.snapshot.observation.revision);
  assert.equal(c.state.apps.refresh.cronRecovery.unexpectedDispatch, true);
  assert.match(c.state.apps.refresh.cronRecovery.checkError, /was not held/);
  await assert.rejects(f.operate(c, 'acknowledge-recovery', acceptance(c)), { code: 'CRON_RECOVERY_UNCONFIRMED' });
  const restarted = f.create(); await restarted.init();
  await assert.rejects(f.operate(restarted, 'acknowledge-recovery', acceptance(restarted)), { code: 'CRON_RECOVERY_UNCONFIRMED' });
  assert.equal(restarted.route('refresh.localhost').state, 'paused');
});

test('restored approval mismatches cannot be acknowledged', async t => {
  for (const field of ['version', 'secretRevision', 'crons']) await t.test(field, async t => {
    const f = await prepared(t);
    if (field === 'crons') {
      f.snapshot.crons = ['*/2 * * * *'];
      f.snapshot.beforePause.crons = f.snapshot.crons; f.snapshot.observation.crons = f.snapshot.crons;
    } else f.snapshot[field] = 'changed';
    const c = await restore(f);
    await assert.rejects(f.operate(c, 'acknowledge-recovery', acceptance(c)), { code: 'CRON_RECOVERY_UNCONFIRMED' });
    assert.equal(c.route('refresh.localhost').state, 'paused');
    assert.equal((await f.runtime()).paused, true);
  });
});

test('a failed intent write prevents pause or snapshot effects and requires reload', async t => {
  const f = await prepared(t), before = (await f.runtime()).events.length;
  f.failWrite(state => state.apps?.refresh?.dispatch.operation === 'pause' ? 'before' : null);
  await assert.rejects(f.operate(f.c, 'snapshot'), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
  await assert.rejects(f.operate(f.c, 'snapshot'), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
  assert.equal((await f.runtime()).events.length, before);
});

test('snapshot validator rejects incomplete observations and uncontrolled revision changes', async t => {
  const f = await prepared(t);
  for (const change of [
    receipt => { delete receipt.beforePause; },
    receipt => { delete receipt.secretRevision; },
    receipt => { receipt.secretRevision = ''; },
    receipt => { receipt.beforePause.paused = 'false'; },
    receipt => { receipt.beforePause.nextAlarm = -1; },
    receipt => { receipt.beforePause.crons = []; },
    receipt => { receipt.observation.revision += 1; },
    receipt => { receipt.observation.nextAlarm = 60000; },
    receipt => { receipt.completedAt = receipt.at - 1; },
  ]) {
    const receipt = structuredClone(f.snapshot); change(receipt); assert.throws(() => validateCronSnapshot(receipt));
  }
});

test('an acknowledgment persistence failure leaves native dispatch held and latches later effects', async t => {
  for (const side of ['before', 'after']) await t.test(side, async t => {
    const f = await prepared(t), c = await restore(f);
    f.failWrite(state => state.apps?.refresh?.cronRecovery?.status === 'acknowledged' ? side : null);
    await assert.rejects(f.operate(c, 'acknowledge-recovery', acceptance(c)), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
    const before = (await f.runtime()).events.length;
    await assert.rejects(f.operate(c, 'resume'), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
    assert.equal((await f.runtime()).events.length, before); assert.equal((await f.runtime()).paused, true);
    f.failWrite(null);
    const restarted = f.create(); await restarted.init();
    assert.equal((await f.runtime()).paused, true);
    assert.equal(restarted.state.apps.refresh.cronRecovery.status, side === 'after' ? 'acknowledged' : 'pending');
    assert.equal(restarted.route('refresh.localhost').state, side === 'after' ? 'active' : 'paused');
  });
});

test('pending recovery cannot be bypassed by removing the submitted cron declaration', async t => {
  const f = await prepared(t), c = await restore(f), update = await f.request(c);
  delete update.resources.crons;
  const before = (await f.runtime()).events.length;
  await assert.rejects(c.mutate(update.id, update.digest, 'approve'), /Acknowledge restored cron recovery/);
  assert.equal((await f.runtime()).events.length, before);
});

test('invalid restored recovery metadata refuses startup before runtime effects', async t => {
  const f = await prepared(t), c = await restore(f), valid = structuredClone(c.state);
  for (const change of [
    state => { state.apps.refresh.route = 'active'; },
    state => { state.apps.refresh.dispatch.desired = 'running'; },
    state => { state.apps.refresh.dispatch.hold = f.input.deployment; },
    state => { state.apps.refresh.uncertain = f.input.deployment; },
    state => { state.requirements = state.requirements.filter(value => value !== cronRecoveryCapability); },
    state => { state.apps.refresh.cronRecovery.id = 'invalid'; },
    state => { state.apps.refresh.cronRecovery.snapshot = 'invalid'; },
  ]) {
    c.state = structuredClone(valid); change(c.state); await c.save();
    const before = (await f.runtime()).events.length;
    await assert.rejects(f.create().init());
    assert.equal((await f.runtime()).events.length, before);
  }
});

test('an interrupted recovery pause reconciles without releasing timers or requiring a new hold revision', async t => {
  const f = await prepared(t), c = await restore(f);
  Object.assign(c.state.apps.refresh.dispatch, { operation: 'pause', observed: 'unknown', observedAt: null });
  await c.save();
  const restarted = f.create(); await restarted.init();
  const app = restarted.state.apps.refresh;
  assert.equal(app.dispatch.operation, null); assert.equal(app.dispatch.observed, 'paused');
  assert.equal((await f.runtime()).revision, f.snapshot.observation.revision);
  assert.equal(app.cronRecovery.checkError, null);
  await f.operate(restarted, 'acknowledge-recovery', acceptance(restarted));
  assert.equal((await f.runtime()).paused, true);
});

test('a mismatched native revision leaves a sticky diagnosis and cannot become a runtime retry', async t => {
  const f = await prepared(t), path = join(f.dir, 'cron-runtime.json'), native = await readJson(path);
  native.revision += 2; await saveJson(path, native);
  const c = await restore(f), receipt = c.state.apps.refresh.cronRecovery;
  assert.equal(receipt.unexpectedRevision, true);
  assert.match(receipt.diagnoses[0], /control history or stored state changed/);
  assert.match(receipt.checkError, /approval or hold revision differs/);
  assert.doesNotMatch(receipt.checkError, /retry after/);
  native.revision = f.snapshot.observation.revision; await saveJson(path, native);
  const restarted = f.create(); await restarted.init();
  await assert.rejects(f.operate(restarted, 'acknowledge-recovery', acceptance(restarted)), { code: 'CRON_RECOVERY_UNCONFIRMED' });
  assert.equal(restarted.route('refresh.localhost').state, 'paused');
  native.paused = false; native.revision++; await saveJson(path, native);
  const activeRestart = f.create(); await activeRestart.init();
  assert.equal((await f.runtime()).paused, true);
  assert.equal(activeRestart.state.apps.refresh.cronRecovery.unexpectedDispatch, true);
  assert.equal(activeRestart.state.apps.refresh.cronRecovery.unexpectedRevision, true);
});

test('an approval mismatch still corrects an active native timer before refusing recovery', async t => {
  const f = await prepared(t), path = join(f.dir, 'cron-runtime.json'), native = await readJson(path);
  f.snapshot.version = 'different-prepared-version';
  native.paused = false; await saveJson(path, native);
  const c = await restore(f);
  assert.equal((await f.runtime()).paused, true);
  assert.equal(c.state.apps.refresh.cronRecovery.unexpectedDispatch, true);
  await assert.rejects(f.operate(c, 'acknowledge-recovery', acceptance(c)), { code: 'CRON_RECOVERY_UNCONFIRMED' });
});
