import test from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../src/http.mjs';
import { routeController } from './fixtures/route-controller.mjs';

async function fixture(t, { pending = false } = {}) {
  const f = await routeController(t), release = await f.request();
  if (pending) f.failPublic(record => record.routes[0]?.state === 'active' ? 'after' : null);
  if (pending) await assert.rejects(f.c.mutate(release.id, release.digest, 'approve'), /uncertain/);
  else await f.c.mutate(release.id, release.digest, 'approve');
  f.failPublic(null);
  const controller = pending ? f.create() : f.c; if (pending) await controller.init();
  const http = server(controller, { user: 'admin', password: 'password', deploy: 'deploy', gateway: 'gateway' }, { recoveryOnly: pending });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${http.address().port}`, auth = { authorization: 'Basic ' + Buffer.from('admin:password').toString('base64') };
  const get = (path = '/routing', headers = auth) => fetch(origin + path, { headers });
  const fields = async () => {
    const response = await get(), page = await response.text(); assert.equal(response.status, 200);
    return new URLSearchParams({ csrf: /name="csrf" value="([a-f0-9]+)"/.exec(page)?.[1] || '', deployment: release.id, digest: release.digest,
      ...(pending ? { intent: controller.state.routeAuthority.pending.id } : {}) });
  };
  const post = (action, data, headers = {}) => fetch(origin + '/routing/alpha/' + action, { method: 'POST', redirect: 'manual', headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: data });
  return { ...f, controller, release, get, post, fields, origin, auth };
}

test('routing page observes authority and offers an exact approval without running a verifier', async t => {
  const f = await fixture(t), response = await f.get(), page = await response.text();
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/html/); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(page, /<h1>HTTP routing<\/h1>/); assert.match(page, /Authority<\/dt><dd class="state">active/);
  assert.ok(page.includes(`name="deployment" value="${f.release.id}"`) && page.includes(`name="digest" value="${f.release.digest}"`));
  assert.ok(page.includes('Pause HTTP') && !page.includes('Verify and resume HTTP')); assert.equal(f.verifications(), 0);
  const root = await f.get('/'); assert.ok((await root.text()).includes('href="/routing"'));
});

test('form pause and resume redirect to fresh GET status instead of replaying a POST on refresh', async t => {
  const f = await fixture(t), selected = await f.fields();
  const pause = await f.post('pause', selected); assert.equal(pause.status, 303); assert.equal(pause.headers.get('location'), '/routing'); await pause.body.cancel();
  assert.equal((await f.public()).routes[0].state, 'withheld');
  const paused = await f.get(), page = await paused.text(); assert.ok(page.includes('Verify and resume HTTP')); assert.ok(page.includes(f.release.digest));
  const resume = await f.post('resume', await f.fields()); assert.equal(resume.status, 303); await resume.body.cancel();
  assert.equal((await f.public()).routes[0].state, 'active'); assert.equal(f.verifications(), 1);
  const before = (await f.public()).revision; const refresh = await f.get(); await refresh.body.cancel(); assert.equal((await f.public()).revision, before); assert.equal(f.verifications(), 1);
});

for (const [name, alter, headers] of [
  ['wrong CSRF', data => data.set('csrf', 'wrong'), {}], ['duplicate fields', data => data.append('deployment', 'other'), {}],
  ['extra fields', data => data.append('extra', 'private-error'), {}], ['oversized input', data => data.set('digest', 'x'.repeat(4097)), {}],
  ['foreign origin', () => {}, { Origin: 'https://foreign.example' }], ['wrong content type', () => {}, { 'Content-Type': 'application/json' }],
]) test(`${name} cannot mutate HTTP authority through a form`, async t => {
  const f = await fixture(t), data = await f.fields(), before = await f.public(); alter(data);
  const response = await f.post('pause', data, headers); assert.equal(response.status, 403); assert.doesNotMatch(await response.text(), /private-error/);
  assert.deepEqual(await f.public(), before); assert.equal(f.verifications(), 0);
});

test('stale approval and uncertain publication withhold success without exposing private errors', async t => {
  const f = await fixture(t), data = await f.fields(), before = await f.public();
  data.set('digest', 'b'.repeat(64)); const stale = await f.post('pause', data); assert.equal(stale.status, 503); assert.match(await stale.text(), /outcome is uncertain/); assert.deepEqual(await f.public(), before);
  f.failPublic(() => 'after'); const uncertain = await f.post('pause', await f.fields()); assert.equal(uncertain.status, 503);
  const text = await uncertain.text(); assert.match(text, /Do not assume a pause succeeded/); assert.doesNotMatch(text, /Public acknowledgment lost/); assert.equal(uncertain.headers.get('location'), null);
});

for (const action of ['reconcile', 'withhold-pending']) test(`recovery page supports exact ${action} without offering resume or approvals`, async t => {
  const f = await fixture(t, { pending: true }), response = await f.get('/'), page = await response.text();
  assert.equal(response.status, 200); assert.match(page, /Recovery only. Keep ingress stopped/); assert.ok(!page.includes('Verify and resume HTTP') && !page.includes('Back to deployment approvals'));
  assert.ok(page.includes(f.controller.state.routeAuthority.pending.id));
  const resume = await f.post('resume', await f.fields()); assert.equal(resume.status, 503); await resume.body.cancel();
  const decision = await f.post(action, await f.fields()); assert.equal(decision.status, 303); await decision.body.cancel();
  assert.equal((await f.public()).routes[0].state, action === 'reconcile' ? 'active' : 'withheld'); assert.equal(f.verifications(), action === 'reconcile' ? 1 : 0);
});

test('unavailable authority has no decision forms and cannot be mistaken for healthy routing', async t => {
  const f = await fixture(t);
  const { writeFile } = await import('node:fs/promises'); await writeFile(f.path, 'private-error');
  const response = await f.get(), page = await response.text(); assert.equal(response.status, 200); assert.match(page, /Routing status is unavailable/); assert.ok(!page.includes('<form')); assert.doesNotMatch(page, /private-error/);
});

test('routing pages and forms require owner authentication before reading or changing authority', async t => {
  const f = await fixture(t), before = await f.public();
  for (const authorization of ['', 'Bearer deploy', 'Bearer gateway']) {
    const response = await f.get('/routing', { authorization }); assert.equal(response.status, 401); await response.body.cancel();
    const mutation = await f.post('pause', new URLSearchParams({ csrf: 'wrong' }), { authorization }); assert.equal(mutation.status, 401); await mutation.body.cancel();
  }
  assert.deepEqual(await f.public(), before);
});

test('invalid UTF-8 form bodies are refused before authority changes', async t => {
  const f = await fixture(t), before = await f.public();
  const response = await f.post('pause', Buffer.from([0xff])); assert.equal(response.status, 403); await response.body.cancel();
  assert.deepEqual(await f.public(), before);
});

test('application labels are escaped in routing HTML instead of becoming markup', async t => {
  const f = await fixture(t), label = '<img src=x onerror="unsafe()">'; f.controller.state.apps[label] = { route: 'paused' };
  const response = await f.get(), page = await response.text(); assert.equal(response.status, 200);
  assert.ok(page.includes('&lt;img src=x onerror=&quot;unsafe()&quot;&gt;')); assert.ok(!page.includes('<img'));
});
