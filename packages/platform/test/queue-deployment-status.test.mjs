import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { server } from '../src/http.mjs';
import { fixture } from './fixtures/queue-controller.mjs';

const PRIVATE = 'private-backend-diagnostic-7f3a';
const approve = (c, r, replaces) => c.mutate(r.id, r.digest, 'approve', undefined, replaces);
const identity = r => ({ deployment: r.id, digest: r.digest });

// Fixture failures keep their real effects; the raw message only gains a marker
// that public status must never echo.
function markBackendErrors(f) {
  const wrap = (target, key) => {
    const original = target[key];
    target[key] = async (...args) => { try { return await original(...args); } catch (error) { throw Error(`${error.message} ${PRIVATE}`); } };
  };
  for (const key of ['bootstrap', 'ready', 'publish', 'migrate', 'applied']) wrap(f.backend, key);
  for (const key of ['pause', 'resume']) wrap(f.backend.queues, key);
}

async function serve(t, controller) {
  const http = server(controller, { user: 'admin', password: 'password', deploy: 'team-secret', gateway: 'gateway' });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  return async (id, token) => {
    const response = await fetch(`http://127.0.0.1:${http.address().port}/v1/deployments/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { code: response.status, body: await response.json() };
  };
}

async function setup(t) {
  const f = await fixture(t); markBackendErrors(f);
  const owner = await f.c.issueCredential('owner', ['imports']), other = await f.c.issueCredential('other', ['imports']);
  const submit = async () => { const r = await f.request(); r.submitter = owner.id; await f.c.save(); return r; };
  return { ...f, owner, other, submit, status: await serve(t, f.c) };
}

function assertPublicFailure(response, stored, step) {
  assert.equal(response.code, 200);
  assert.equal(response.body.status, 'failed');
  assert.equal(response.body.step, step);
  assert.equal(typeof response.body.error, 'string'); assert.ok(response.body.error.length);
  assert.notEqual(response.body.error, stored.error);
  assert.doesNotMatch(JSON.stringify(response.body), new RegExp(PRIVATE));
  for (const key of ['version', 'secretRevision', 'replaces', 'submitter']) assert.equal(Object.hasOwn(response.body, key), false, key);
}

async function snapshot(f, controller = f.c) {
  return { disk: await readFile(join(controller.dir, 'state.json'), 'utf8'), memory: JSON.stringify(controller.state), events: [...f.events], paused: f.paused() };
}

// Only the submitting credential reads status; same-app scope and the team token do not inherit it.
async function assertOnlySubmitterReads(f, status, id) {
  const response = await status(id, f.owner.token);
  for (const token of [f.other.token, 'team-secret']) {
    const denied = await status(id, token);
    assert.equal(denied.code, 404); assert.equal(Object.hasOwn(denied.body, 'step'), false);
  }
  assert.equal((await status(id)).code, 401);
  return response;
}

test('real queue activation backend failures report their step with a fixed explanation and read-only status', async t => {
  const cases = [
    ['bootstrap', 'publishing-queue-bootstrap'], ['ready', 'waiting-for-queue-bootstrap'], ['pause', 'pausing-delivery'],
    ['ledger', 'checking-migration-ledger'], ['migrate', 'migrating'], ['publish', 'publishing'], ['resume', 'releasing-delivery'],
  ];
  for (const [effect, step] of cases) await t.test(step, async t => {
    const f = await setup(t), r = await f.submit(); f.fail(effect);
    await approve(f.c, r);
    assert.equal(r.status, 'failed'); assert.equal(r.step, step); assert.match(r.error, new RegExp(PRIVATE));
    assert.equal(f.c.state.apps.imports.delivery.hold, r.id);
    const before = await snapshot(f);
    assertPublicFailure(await assertOnlySubmitterReads(f, f.status, r.id), r, step);
    assert.deepEqual(await snapshot(f), before, 'status never mutates state, the hold, or delivery');
    if (effect === 'resume') assert.equal(f.paused(), false, 'uncertain resume stays as observed');
    else if (effect !== 'bootstrap' && effect !== 'ready') assert.equal(f.paused(), true, 'status never resumes paused delivery');
  });
});

test('interrupted queue intent writes report their step after metadata reload', async t => {
  for (const step of ['queue-bootstrap-intent', 'queue-application-intent']) await t.test(step, async t => {
    const f = await setup(t), r = await f.submit();
    f.failWrite(state => state.deployments?.[r.id]?.step === step ? 'after' : null);
    await assert.rejects(approve(f.c, r), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
    f.failWrite(null); const restarted = f.create(); await restarted.init();
    const restored = restarted.state.deployments[r.id], status = await serve(t, restarted);
    assert.equal(restored.status, 'failed'); assert.equal(restored.step, step);
    assert.equal(restarted.state.apps.imports.delivery.hold, r.id);
    const before = await snapshot(f, restarted);
    assertPublicFailure(await assertOnlySubmitterReads(f, status, r.id), restored, step);
    assert.deepEqual(await snapshot(f, restarted), before);
    assert.equal(f.events.includes('resume'), false);
  });
});

test('lost hold-transfer response fails the replacement with a fixed explanation and leaves the original status intact', async t => {
  const f = await setup(t), old = await f.submit(); f.fail('migrate');
  await approve(f.c, old); assert.equal(old.step, 'migrating');
  const original = await f.status(old.id, f.owner.token), next = await f.submit();
  const pause = f.backend.queues.pause;
  f.backend.queues.pause = async (...args) => {
    const result = await pause(...args);
    if (next.step === 'transferring-delivery-hold') throw Error(`Lost transfer pause response ${PRIVATE}`);
    return result;
  };
  await assert.rejects(approve(f.c, next, identity(old)), new RegExp(PRIVATE));
  assert.equal(next.status, 'failed'); assert.equal(next.step, 'transferring-delivery-hold');
  assert.equal(f.c.state.apps.imports.delivery.hold, next.id); assert.equal(f.paused(), true);
  const before = await snapshot(f);
  assertPublicFailure(await assertOnlySubmitterReads(f, f.status, next.id), next, 'transferring-delivery-hold');
  assert.deepEqual(await f.status(old.id, f.owner.token), original);
  assert.deepEqual(await snapshot(f), before);
});

test('every step persisted by queue activation and replacement survives public status', async t => {
  const f = await setup(t), steps = new Set();
  f.failWrite(state => { for (const d of Object.values(state.deployments || {})) steps.add(d.step); return null; });
  const old = await f.submit(); f.fail('resume'); await approve(f.c, old);
  const next = await f.submit(); await approve(f.c, next, identity(old));
  assert.equal(next.status, 'active'); f.failWrite(null);
  assert.ok(steps.has('transferring-delivery-hold') && steps.has('queue-bootstrap-intent'), 'activation and replacement both ran');
  const probe = await f.submit();
  for (const step of steps) {
    Object.assign(probe, { status: 'failed', step, error: PRIVATE });
    const response = await f.status(probe.id, f.owner.token);
    assert.equal(response.body.step, step);
    if (step !== 'submitted') assertPublicFailure(response, probe, step);
  }
});

test('an unknown future step stays unknown with a generic explanation', async t => {
  const f = await setup(t), r = await f.submit(); f.fail('pause'); await approve(f.c, r);
  const known = await f.status(r.id, f.owner.token);
  r.step = 'draining-delivery-v2'; await f.c.save();
  const restarted = f.create(); await restarted.init();
  const response = await (await serve(t, restarted))(r.id, f.owner.token);
  assertPublicFailure(response, restarted.state.deployments[r.id], 'unknown');
  assert.doesNotMatch(JSON.stringify(response.body), /draining-delivery-v2/);
  assert.notEqual(response.body.error, known.body.error);
});
