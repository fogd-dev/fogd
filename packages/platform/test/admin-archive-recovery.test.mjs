import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.mjs';
import { server } from '../src/http.mjs';
import { decisionFixture } from './fixtures/decision-controller.mjs';
import { archiveApprovalFixture, archive } from './fixtures/archive-approval.mjs';

async function fixture(t) {
  const f = await archiveApprovalFixture(t);
  const c = new Controller({ ...f.settings, archiveProfile: f.profile }); await c.init();
  const credentials = { user: 'archive-owner', password: 'private-owner-password', gateway: 'unused-gateway' };
  const http = server(c, credentials); await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  const origin = `http://127.0.0.1:${http.address().port}`, authorization = `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`;
  const get = (path, auth = authorization) => fetch(origin + path, { headers: auth ? { authorization: auth } : {} });
  const csrf = (await (await get('/v1/admin')).json()).csrf;
  const post = (name, input, headers = {}) => fetch(`${origin}/v1/apps/${name}/archive-recovery/approve`, { method: 'POST',
    headers: { authorization, 'content-type': 'application/json', 'x-fogd-csrf': csrf, ...headers }, body: JSON.stringify(input) });
  return { ...f, c, get, post, csrf };
}

test('owner API provides an exact recovery review and records approval while HTTP remains withheld', async t => {
  const f = await fixture(t), response = await f.get('/v1/apps/demo/archive-recovery');
  assert.equal(response.status, 200);
  const review = await response.json();
  assert.equal(review.app, 'demo'); assert.equal(review.state, 'pending'); assert.equal(review.execution, 'held');
  assert.deepEqual(review.selection, f.input);
  assert.ok(!JSON.stringify(review).includes('private-current-vault-fixture'));
  assert.ok(!JSON.stringify(review).includes('slots/'));
  assert.ok(!JSON.stringify(review).includes(f.release.version));
  const result = await f.post('demo', { ...review.selection, review: review.review });
  assert.equal(result.status, 200); assert.equal((await result.json()).execution, 'held');
  const state = await f.disk();
  assert.equal(state.appArchives.records[archive].status, 'recovered');
  assert.deepEqual(state.decisions.at(-1).actor, { kind: 'basic', name: 'archive-owner' });
  assert.equal(state.decisions.at(-1).outcome, 'succeeded');
  assert.equal(state.apps.demo.route, 'paused');
  assert.equal((await f.public()).routes[0].state, 'withheld');
  assert.equal((await f.get('/v1/apps/demo/archive-recovery')).status, 404);
});

for (const auth of [null, 'Bearer team-token']) test(`archive recovery requires owner authentication: ${auth || 'anonymous'}`, async t => {
  const f = await fixture(t);
  assert.equal((await f.get('/v1/apps/demo/archive-recovery', auth)).status, 401);
});

for (const [name, headers] of [
  ['missing CSRF', { 'x-fogd-csrf': '' }],
  ['foreign origin', { origin: 'https://unrelated.invalid' }],
]) test(`${name} refuses before creating a recovery intent`, async t => {
  const f = await fixture(t), review = await (await f.get('/v1/apps/demo/archive-recovery')).json(), before = await f.disk();
  assert.equal((await f.post('demo', { ...review.selection, review: review.review }, headers)).status, 403);
  assert.deepEqual(await f.disk(), before);
});

test('body-supplied actor and mismatched app cannot replace the authenticated recovery selection', async t => {
  const f = await fixture(t), review = await (await f.get('/v1/apps/demo/archive-recovery')).json(), before = await f.disk();
  assert.equal((await f.post('demo', { ...review.selection, review: review.review, actor: { kind: 'basic', name: 'forged' } })).status, 409);
  assert.equal((await f.post('other', { ...review.selection, review: review.review })).status, 404);
  assert.deepEqual(await f.disk(), before);
});

test('a stale recovery review refuses and keeps the archive pending', async t => {
  const f = await fixture(t), review = await (await f.get('/v1/apps/demo/archive-recovery')).json();
  f.c.state.apps.demo.reason = 'review context changed';
  const response = await f.post('demo', { ...review.selection, review: review.review });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, 'Archive recovery approval is unconfirmed; keep routes and background work held and retain all stores');
  const state = await f.disk();
  assert.equal(state.apps.demo.archiveRecovery.status, 'pending');
  assert.equal(state.decisions.at(-1).outcome, 'refused');
});

test('ordinary HTTP composition exposes no archive recovery endpoint', async t => {
  const f = await decisionFixture(t), http = await f.listen();
  assert.equal(f.controller.archives.enabled, false);
  assert.equal((await http.get('/v1/apps/demo/archive-recovery')).status, 404);
  const csrf = (await (await http.get('/v1/admin')).json()).csrf;
  const response = await fetch(http.origin + '/v1/apps/demo/archive-recovery/approve', { method: 'POST',
    headers: { authorization: http.authorization, 'content-type': 'application/json', 'x-fogd-csrf': csrf }, body: '{}' });
  assert.equal(response.status, 404);
});

test('an owner API native-check failure records unconfirmed and preserves all execution holds', async t => {
  const f = await fixture(t), review = await (await f.get('/v1/apps/demo/archive-recovery')).json();
  f.failNative();
  assert.equal((await f.post('demo', { ...review.selection, review: review.review })).status, 409);
  const state = await f.disk();
  assert.equal(state.decisions.at(-1).outcome, 'unconfirmed');
  assert.equal(state.apps.demo.archiveRecovery.status, 'pending');
  assert.equal(state.apps.demo.route, 'paused');
  assert.equal((await f.public()).routes[0].state, 'withheld');
});
