import { approvalButtons } from '../src/admin-approval-controls.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../src/http.mjs';
import { routeController } from './fixtures/route-controller.mjs';

async function httpFixture(t) {
  const f = await routeController(t), request = await f.request(); await f.c.mutate(request.id, request.digest, 'approve');
  const credentials = { user: 'admin', password: 'password', deploy: 'deploy', gateway: 'gateway' };
  const http = server(f.c, credentials); await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${http.address().port}`, auth = { authorization: `Basic ${Buffer.from('admin:password').toString('base64')}` };
  const response = await fetch(origin + '/v1/admin', { headers: auth }), admin = await response.json();
  const post = (action, extra = {}) => fetch(origin + '/v1/apps/alpha/routing/' + action, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Fogd-CSRF': admin.csrf, ...extra }, body: JSON.stringify({ deployment: request.id, digest: request.digest }) });
  return { ...f, activeRequest: request, credentials, origin, auth, post };
}
test('routing decisions require admin and CSRF authorization before changing actual authority', async t => {
  const f = await httpFixture(t);
  const unauthorized = await f.post('pause', { authorization: 'Bearer deploy' }); assert.equal(unauthorized.status, 401); await unauthorized.body.cancel();
  const csrf = await f.post('pause', { 'X-Fogd-CSRF': '' }); assert.equal(csrf.status, 403); await csrf.body.cancel();
  assert.equal((await f.public()).routes[0].state, 'active');
  const pause = await f.post('pause'); assert.equal(pause.status, 200); assert.equal((await pause.json()).state, 'withheld');
  const get = await fetch(f.origin + '/v1/apps/alpha/routing', { headers: f.auth }); assert.equal((await get.json()).state, 'withheld');
  const resume = await f.post('resume'); assert.equal(resume.status, 200); assert.equal((await resume.json()).state, 'active');
  assert.equal(f.verifications(), 1);
});
test('durable controller has no internal route lookup fallback', async t => {
  const f = await httpFixture(t), internal = server(f.c, f.credentials, { role: 'internal' });
  await new Promise(resolve => internal.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { internal.close(resolve); internal.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${internal.address().port}/internal/route?host=alpha.localhost`, { headers: { authorization: 'Bearer gateway' } });
  assert.equal(response.status, 404); assert.deepEqual(await response.json(), { error: 'Not found' });
  assert.equal((await f.public()).routes[0].submission, f.activeRequest.id);
});

test('route persistence uncertainty is reported as service unavailability', async t => {
  const f = await httpFixture(t), update = await f.request('alpha');
  f.failPublic(record => record.routes[0]?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(update.id, update.digest, 'approve'), /uncertain/);
  const response = await fetch(f.origin + '/v1/apps/alpha/routing', { headers: f.auth });
  assert.equal(response.status, 503); assert.match((await response.json()).error, /uncertain/);
});
test('pending HTTP withdrawal requires the exact app, intent and approval', async t => {
  const f = await routeController(t), request = await f.request();
  f.failPublic(record => record.routes[0]?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(request.id, request.digest, 'approve'), /uncertain/); f.failPublic(null);
  const c = f.create(); await c.init(); const before = [...f.events];
  const credentials = { user: 'admin', password: 'password', deploy: 'deploy', gateway: 'gateway' };
  const http = server(c, credentials, { recoveryOnly: true }); await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${http.address().port}`, auth = { authorization: `Basic ${Buffer.from('admin:password').toString('base64')}` };
  const admin = await (await fetch(origin + '/v1/admin', { headers: auth })).json();
  const input = { intent: c.state.routeAuthority.pending.id, deployment: request.id, digest: request.digest };
  const post = (app, value) => fetch(origin + `/v1/apps/${app}/routing/withhold-pending`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Fogd-CSRF': admin.csrf }, body: JSON.stringify(value) });
  const wrongApp = await post('beta', input); assert.equal(wrongApp.status, 400); await wrongApp.body.cancel();
  const wrongIntent = await post('alpha', { ...input, intent: 'active:999' }); assert.equal(wrongIntent.status, 400); await wrongIntent.body.cancel();
  const wrongDigest = await post('alpha', { ...input, digest: 'b'.repeat(64) }); assert.equal(wrongDigest.status, 400); await wrongDigest.body.cancel();
  assert.equal((await f.public()).routes[0].state, 'active');
  const result = await post('alpha', input); assert.equal(result.status, 200); assert.equal((await result.json()).state, 'withheld');
  assert.deepEqual(f.events, before); assert.equal(f.verifications(), 0);
});
test('approval page selects the failed non-queue HTTP predecessor for corrected approval', async t => {
  const f = await httpFixture(t), failed = await f.request(); f.fail('publish'); await f.c.mutate(failed.id, failed.digest, 'approve');
  const corrected = await f.request();
  const response = await fetch(f.origin + '/', { headers: f.auth }); assert.equal(response.status, 200);
  assert.ok((await response.text()).includes(`/admin/review/${corrected.id}`));
  // This private routing fixture deliberately omits canonical artifact fields.
  assert.equal((await fetch(f.origin + '/admin/review/' + corrected.id, { headers: f.auth })).status, 409);
  const page = approvalButtons(f.c, corrected, '0'.repeat(64)); assert.ok(page.includes(`data-replaces="${failed.id}"`)); assert.ok(page.includes('HTTP hold and applied migrations'));
});
