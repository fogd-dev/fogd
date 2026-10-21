import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, slots } from './fixtures/cron-controller.mjs';
import { Controller } from '../src/controller.mjs';
import { retireState } from '../src/retirement.mjs';
import { operateDispatch } from '../src/admin-dispatch.mjs';
import { adminState } from '../src/admin-view.mjs';
import { readJson } from '../src/store.mjs';

async function retiredController(t) {
  const f = await fixture(t), request = await f.request(f.c, { requiredSecrets: ['REFRESH_TOKEN'] });
  const secret = await f.c.replaceSecrets('refresh', { REFRESH_TOKEN: 'retained-private-cron-secret' });
  await f.c.mutate(request.id, request.digest, 'approve', secret.revision);
  await f.c.exclusive(() => operateDispatch(f.c, 'refresh', 'snapshot', { deployment: request.id, digest: request.digest }));
  const source = structuredClone(f.c.state), evidence = { previous: { slot: 'one', prefix: 'one' }, replacement: { prefix: 'fresh/one' }, snapshot: { sha256: 'e'.repeat(64) } };
  const retired = retireState(source, 'refresh', request.digest, evidence, { stopScheduledWork: true });
  const dir = await mkdtemp(join(tmpdir(), 'fogd-retired-cron-controller-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(f.dir, dir, { recursive: true }); await writeFile(join(dir, 'state.json'), JSON.stringify(retired));
  const replacementSlots = slots.map(slot => ({ ...slot, prefix: 'fresh/one' }));
  // Ownership reads are permitted on the fresh namespace. Any other backend
  // operation would fail because no runtime transport is provided.
  const controller = new Controller({ dir, slots: replacementSlots, backend: { owner: async () => null } });
  await controller.init();
  return { f, source, controller, request, secret, retired, dir, replacementSlots };
}

test('a controller boots retired cron history without a cron transport and blocks all old runtime authority', async t => {
  const { f, source, controller, request, secret } = await retiredController(t);
  assert.equal(controller.route('refresh.localhost').state, 'unknown');
  assert.equal(controller.state.apps.refresh.route, 'retired');
  assert.equal(controller.available('replacement').prefix, 'fresh/one');
  assert.throws(() => controller.available('refresh'), /permanently retired/);
  for (const action of ['approve', 'reject']) await assert.rejects(controller.mutate(request.id, request.digest, action), /permanently retired/);
  for (const action of ['observe', 'pause', 'resume', 'snapshot', 'acknowledge-recovery']) {
    await assert.rejects(controller.exclusive(() => operateDispatch(controller, 'refresh', action)), /no scheduled dispatch journal/);
  }
  await assert.rejects(controller.replaceSecrets('refresh', { REFRESH_TOKEN: 'changed' }), /permanently retired/);
  await assert.rejects(controller.issueCredential('old app', ['refresh']), /permanently retired/);
  assert.deepEqual((await controller.secrets.select(request, secret.revision)).revision, secret.revision);
  assert.deepEqual(await readJson(join(f.dir, 'state.json')), source);
  assert.equal((await f.runtime()).paused, true);
  const view = adminState(controller), audit = view.apps.refresh.retirement.cron;
  assert.equal(audit.stopScheduledWork, true);
  assert.deepEqual(audit.crons, ['* * * * *']);
  assert.equal(audit.snapshot.revision, source.apps.refresh.cronSnapshot.observation.revision);
  assert.equal(audit.prepared, undefined); assert.equal(audit.dispatch, undefined);
  const visible = JSON.stringify(view);
  assert.ok(!visible.includes('retained-private-cron-secret'));
  assert.ok(!visible.includes(request.version));
  assert.ok(!JSON.stringify(audit).includes(secret.revision));
});

test('startup rejects a damaged retired audit before consulting backend ownership or any runtime', async t => {
  const { controller, dir, retired, replacementSlots } = await retiredController(t);
  assert.equal(controller.state.apps.refresh.route, 'retired');
  for (const [change, expected] of [
    [state => { state.apps.refresh.retirement.cron.dispatch.operation = 'resume'; }, /completed paused activation/],
    [state => { state.apps.refresh.retirement.cron.prepared.observation.revision++; }, /changed outside snapshot pause/],
    [state => { state.apps.refresh.dispatch = null; }, /operational dispatch state/],
    [state => { delete state.apps.refresh.retirement.cron; }, /stopped-work audit/],
    [state => { state.deployments[state.apps.refresh.active].status = 'active'; }, /retired approval/],
    [state => { state.apps.refresh.slot = 'one'; }, /Invalid retirement tombstone/],
  ]) {
    const state = structuredClone(retired); change(state);
    await writeFile(join(dir, 'state.json'), JSON.stringify(state));
    let consultedBackend = false;
    const restarted = new Controller({ dir, slots: replacementSlots, backend: { owner: async () => { consultedBackend = true; return null; } } });
    await assert.rejects(restarted.init(), expected);
    assert.equal(consultedBackend, false, 'Damaged retirement must fail before backend observation');
  }
});
