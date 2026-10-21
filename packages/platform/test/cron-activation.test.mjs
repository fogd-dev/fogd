import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, slots } from './fixtures/cron-controller.mjs';
import { Controller } from '../src/controller.mjs';
import { cronBackend } from './fixtures/cron-backend.mjs';
import { readJson } from '../src/store.mjs';
import { dispatchFor } from '../src/cron-activation.mjs';
import { cronCapability } from '../src/cron-dispatch.mjs';
import { deploymentStatus } from '../src/deployment-status.mjs';
import { translateConfig } from '@fogd/runtime/artifact';
import { retirementApp } from '../src/retirement.mjs';
import { resourceChanges } from '../src/resources.mjs';
import { adminState } from '../src/admin-view.mjs';
import { assertQueueFreeRecovery } from '../../cli/src/recovery/queue-safety.mjs';
import { queueBackupApps } from '../../cli/src/recovery/queue-backup.mjs';

const approve = (c, request, revision) => c.mutate(request.id, request.digest, 'approve', revision);

test('private cron approval bootstraps D1, holds dispatch, migrates and publishes before release', async t => {
  const f = await fixture(t), request = await f.request();
  assert.deepEqual((await f.runtime()).events, []);
  await approve(f.c, request);
  assert.equal(request.status, 'active');
  assert.deepEqual((await f.runtime()).events, ['bootstrap', 'ready', 'pause', 'ledger', 'migrate', 'ledger', 'publish', 'ready', 'resume']);
  const first = f.c.state.apps.refresh.dispatch;
  assert.equal(first.hold, null); assert.equal(first.version, request.version);
  const before = (await f.runtime()).events.length;
  const update = await f.request(f.c, { crons: ['*/2 * * * *'] });
  await approve(f.c, update);
  assert.equal(update.status, 'active');
  assert.deepEqual((await f.runtime()).events.slice(before), ['pause', 'ledger', 'migrate', 'ledger', 'publish', 'ready', 'resume']);
  assert.deepEqual((await f.runtime()).crons, ['*/2 * * * *']);
});

test('operator dispatch pause is preserved through an approved update independently of HTTP routing', async t => {
  const f = await fixture(t); await approve(f.c, await f.request());
  await f.c.exclusive(() => dispatchFor(f.c, f.c.state.apps.refresh, slots[0]).pause());
  const before = (await f.runtime()).events.length;
  const update = await f.request(); await approve(f.c, update);
  assert.equal(update.status, 'active'); assert.equal((await f.runtime()).paused, true);
  assert.equal(f.c.route('refresh.localhost').state, 'active');
  assert.ok(!(await f.runtime()).events.slice(before).includes('resume'));
  assert.equal(f.c.state.apps.refresh.dispatch.desired, 'paused');
});

test('lost cron activation responses keep the original approval and restart never resumes implicitly', async t => {
  for (const failure of ['bootstrap', 'ready', 'pause', 'ledger', 'migrate', 'publish', 'resume']) {
    await t.test(failure, async t => {
      const f = await fixture(t), request = await f.request(); f.fail(failure);
      await approve(f.c, request); assert.equal(request.status, 'failed');
      assert.equal(f.c.state.apps.refresh.dispatch.hold, request.id);
      if (failure === 'resume') assert.equal((await f.runtime()).paused, false);
      await assert.rejects(f.c.mutate(request.id, request.digest, 'reject'), /held cron activation/);
      const other = await f.request(); await assert.rejects(approve(f.c, other), /held cron activation/);
      await f.c.mutate(other.id, other.digest, 'reject');
      const before = (await f.runtime()).events.length, restarted = f.create(); await restarted.init();
      assert.ok(!(await f.runtime()).events.slice(before).includes('resume'));
      if (restarted.state.apps.refresh.cronBootstrap.phase !== 'pending') assert.equal((await f.runtime()).paused, true);
      await approve(restarted, restarted.state.deployments[request.id]);
      assert.equal(restarted.state.deployments[request.id].status, 'active');
      assert.deepEqual(restarted.state.apps.refresh.migrations, request.migrations);
      if (['publish', 'resume'].includes(failure)) assert.ok(!(await f.runtime()).events.slice(before).includes('bootstrap'));
    });
  }
});

test('approval pins artifact and secrets before ownership effects and retries retain the selected revision', async t => {
  const f = await fixture(t), request = await f.request(f.c, { requiredSecrets: ['REFRESH_TOKEN'] });
  const selected = await f.c.replaceSecrets('refresh', { REFRESH_TOKEN: 'first-private-value' });
  const claim = f.backend.claim;
  f.backend.claim = async (...args) => {
    const durable = await readJson(join(f.dir, 'state.json'));
    assert.equal(durable.deployments[request.id].secretRevision, selected.revision);
    assert.equal(durable.deployments[request.id].digest, request.digest);
    assert.equal(durable.deployments[request.id].status, 'activating');
    return claim(...args);
  };
  f.fail('publish'); await approve(f.c, request, selected.revision);
  assert.equal(request.status, 'failed');
  await f.c.replaceSecrets('refresh', { REFRESH_TOKEN: 'second-private-value' });
  await approve(f.c, request, selected.revision);
  assert.equal(request.status, 'active');
  assert.equal((await f.runtime()).vars.REFRESH_TOKEN, 'first-private-value');
  assert.ok((await f.runtime()).events.includes('application-ready'));
  const artifact = await readFile(join(f.c.artifact(request.id), 'wrangler.json'), 'utf8');
  assert.doesNotMatch(artifact, /private-value/);
  assert.doesNotMatch(JSON.stringify(f.c.state), /private-value/);
  assert.doesNotMatch(JSON.stringify(deploymentStatus(request)), /private-value/);
  assert.ok(!JSON.stringify(adminState(f.c)).includes(request.version));
  assert.equal(adminState(f.c).apps.refresh.dispatch.version, undefined);
});

test('ambiguous metadata writes stop further cron effects and require disk reload before explicit retry', async t => {
  const boundaries = [
    ['cron-bootstrap-intent', () => true], ['publishing-cron-bootstrap', () => true],
    ['waiting-for-cron-bootstrap', () => true],
    ['pausing-dispatch', app => app.dispatch.operation === 'pause'],
    ['migrating', () => true], ['cron-application-intent', () => true],
    ['waiting-for-replicas', () => true],
    ['releasing-dispatch', app => app.dispatch.operation === 'resume'],
    ['releasing-dispatch', app => app.dispatch.hold === null], ['complete', () => true],
  ];
  for (const [step, condition] of boundaries) for (const side of ['before', 'after']) {
    await t.test(`${step} ${side}`, async t => {
      const f = await fixture(t), request = await f.request();
      f.failWrite(state => state.deployments?.[request.id]?.step === step && condition(state.apps.refresh) ? side : null);
      await assert.rejects(approve(f.c, request), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
      const before = (await f.runtime()).events.length;
      await assert.rejects(approve(f.c, request), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
      assert.equal((await f.runtime()).events.length, before);
      f.failWrite(null); const restarted = f.create(); await restarted.init();
      assert.ok(!(await f.runtime()).events.slice(before).includes('resume'));
      const saved = restarted.state.deployments[request.id];
      if (saved.status !== 'active') await approve(restarted, saved);
      assert.equal(saved.status, 'active');
    });
  }
});

test('SIGKILL at first activation and update boundaries requires rehold and explicit approval', async t => {
  for (const update of [false, true]) for (const point of ['effect:bootstrap', 'effect:pause', 'effect:migrate', 'application-intent', 'effect:publish', 'effect:resume', 'released']) {
    if (update && point === 'effect:bootstrap') continue;
    await t.test(`${update ? 'update' : 'initial'} ${point}`, async t => {
      const f = await fixture(t);
      if (update) await approve(f.c, await f.request());
      const request = await f.request();
      const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/cron-activation-crash.mjs', import.meta.url)), f.dir, request.id, point], { encoding: 'utf8', timeout: 15000 });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const before = await f.runtime();
      const restarted = new Controller({ cronApps: true, dir: f.dir, slots, backend: cronBackend(f.dir) }); await restarted.init();
      const after = await f.runtime();
      assert.equal(restarted.state.deployments[request.id].status, 'failed');
      assert.equal(restarted.state.apps.refresh.dispatch.hold, request.id);
      assert.equal(restarted.route('refresh.localhost').state, 'paused');
      assert.ok(!after.events.slice(before.events.length).includes('resume'));
      if (restarted.state.apps.refresh.cronBootstrap.phase !== 'pending') assert.equal(after.paused, true);
      await approve(restarted, restarted.state.deployments[request.id]);
      assert.equal(restarted.state.deployments[request.id].status, 'active');
      if (before.events.includes('publish')) assert.ok(!(await f.runtime()).events.slice(before.events.length).includes('bootstrap'));
    });
  }
});

test('missing capability, runtime or dispatch metadata fails closed before startup effects', async t => {
  const f = await fixture(t), request = await f.request();
  f.c.state.requirements = []; await f.c.save();
  await assert.rejects(f.create().init(), /capability marker/);
  assert.deepEqual((await f.runtime()).events, []);
  f.c.state.requirements = [cronCapability]; await f.c.save();
  const runtime = f.backend.crons; delete f.backend.crons;
  await assert.rejects(f.create().init(), /qualified runtime transport/);
  assert.deepEqual((await f.runtime()).events, []);
  f.backend.crons = runtime; await approve(f.c, request);
  delete f.c.state.apps.refresh.dispatch; await f.c.save();
  await assert.rejects(f.create().init(), /missing its dispatch journal/);
});

test('an unreachable update hold leaves old dispatch running, blocks migration and stays unknown on restart', async t => {
  const f = await fixture(t), first = await f.request(); await approve(f.c, first);
  const request = await f.request(), before = (await f.runtime()).events.length;
  f.fail('pause', 'before'); await approve(f.c, request);
  assert.equal(request.status, 'failed'); assert.equal(request.step, 'pausing-dispatch');
  assert.deepEqual((await f.runtime()).events.slice(before), []);
  assert.equal((await f.runtime()).paused, false); assert.equal((await f.runtime()).version, first.version);
  assert.equal(f.c.route('refresh.localhost').state, 'paused');
  f.fail('pause', 'before'); const restarted = f.create(); await restarted.init();
  const app = restarted.state.apps.refresh;
  assert.equal(app.dispatch.observed, 'unknown'); assert.equal(app.dispatch.operation, 'pause');
  assert.equal(app.dispatch.hold, request.id); assert.match(app.dispatchRecoveryError, /could not be confirmed/);
  assert.equal((await f.runtime()).paused, false, 'Unknown observation must not masquerade as a timer pause');
  const other = await f.request(restarted); await assert.rejects(approve(restarted, other), /held cron activation/);
  await approve(restarted, restarted.state.deployments[request.id]);
  assert.equal(restarted.state.deployments[request.id].status, 'active');
  assert.equal(app.dispatchRecoveryError, undefined);
});

test('a lost operator pause response stays unconfirmed through restart until explicit reconciliation', async t => {
  const f = await fixture(t); await approve(f.c, await f.request());
  f.fail('pause');
  await assert.rejects(f.c.exclusive(() => dispatchFor(f.c, f.c.state.apps.refresh, slots[0]).pause()), /Lost pause/);
  const before = (await f.runtime()).events.length, restarted = f.create(); await restarted.init();
  const app = restarted.state.apps.refresh;
  assert.equal(app.dispatch.desired, 'paused'); assert.equal(app.dispatch.observed, 'unknown');
  assert.equal(app.dispatch.operation, 'pause'); assert.equal(app.dispatch.hold, null);
  assert.deepEqual((await f.runtime()).events.slice(before), []);
  await restarted.exclusive(() => dispatchFor(restarted, app, slots[0]).reconcile());
  assert.equal(app.dispatch.observed, 'paused'); assert.equal(app.dispatch.operation, null);
});

test('operator pause survives a killed update and suppresses resume on explicit activation retry', async t => {
  const f = await fixture(t); await approve(f.c, await f.request());
  await f.c.exclusive(() => dispatchFor(f.c, f.c.state.apps.refresh, slots[0]).pause());
  const request = await f.request(), before = (await f.runtime()).events.length;
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/cron-activation-crash.mjs', import.meta.url)), f.dir, request.id, 'effect:publish'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const restarted = f.create(); await restarted.init();
  assert.equal(restarted.state.apps.refresh.dispatch.desired, 'paused');
  await approve(restarted, restarted.state.deployments[request.id]);
  assert.equal(restarted.state.deployments[request.id].status, 'active');
  assert.equal((await f.runtime()).paused, true);
  assert.ok(!(await f.runtime()).events.slice(before).includes('resume'));
});

test('operator pause reconciles a lost activation resume without releasing its approval hold', async t => {
  const f = await fixture(t), request = await f.request(); f.fail('resume'); await approve(f.c, request);
  assert.equal(request.status, 'failed'); assert.equal((await f.runtime()).paused, false);
  await f.c.exclusive(() => dispatchFor(f.c, f.c.state.apps.refresh, slots[0]).pause());
  assert.equal((await f.runtime()).paused, true);
  assert.equal(f.c.state.apps.refresh.dispatch.hold, request.id);
  const before = (await f.runtime()).events.length;
  await approve(f.c, request);
  assert.equal(request.status, 'active'); assert.equal((await f.runtime()).paused, true);
  assert.ok(!(await f.runtime()).events.slice(before).includes('resume'));
});

test('cron activation foundation keeps ordinary admission and unqualified lifecycle paths closed', async t => {
  assert.throws(() => translateConfig({ name: 'refresh', main: 'index.js', triggers: { crons: ['* * * * *'] } }, 'refresh'), /Unsupported binding\/config: triggers/);
  const f = await fixture(t), request = await f.request(); await approve(f.c, request);
  assert.throws(() => retirementApp(f.c.state, 'refresh', request.digest), /requires --stop-scheduled-work/);
  assert.throws(() => assertQueueFreeRecovery(f.c.state), /Scheduled history/);
  assert.throws(() => queueBackupApps(f.c.state), /Scheduled history/);
  const resources = request.resources;
  const { crons, ...withoutCron } = resources;
  assert.throws(() => resourceChanges(resources, withoutCron), /removing cron dispatch/);
  assert.throws(() => resourceChanges(withoutCron, resources), /removing cron dispatch/);
  const other = await f.request();
  await assert.rejects(f.c.mutate(other.id, other.digest, 'approve', undefined, { deployment: request.id, digest: request.digest }), /Replacing a held cron activation is not qualified/);
});

test('malformed cron declarations cannot acquire activation authority', () => {
  for (const resources of [
    { crons: ['* * * * *'], script: undefined }, { crons: ['* * * * *'], script: null },
    { crons: null, script: 'refresh' }, { crons: [], script: 'refresh' },
    { crons: [' '], script: 'refresh' }, { crons: [1], script: 'refresh' },
    { crons: ['* * * * *'], script: 'refresh', queues: {} },
  ]) {
    assert.throws(() => resourceChanges(null, { ...resources, r2: [] }), /Invalid cron|Combined cron/);
  }
});
