import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { routeController } from './fixtures/route-controller.mjs';
import { serveController } from '../src/controller-service.mjs';

const credentials = { user: 'admin', password: 'password', deploy: 'deploy', gateway: 'gateway' };
const auth = { authorization: `Basic ${Buffer.from('admin:password').toString('base64')}` }, challenge = 'a'.repeat(64);
async function fixture(t, pending = false) {
  const f = await routeController(t), release = await f.request();
  if (pending) f.failPublic(record => record.routes[0]?.state === 'active' ? 'after' : null);
  if (pending) await assert.rejects(f.c.mutate(release.id, release.digest, 'approve'), /uncertain/);
  else await f.c.mutate(release.id, release.digest, 'approve');
  f.failPublic(null);
  const service = await serveController(f.create(), credentials, { port: 0, host: '127.0.0.1' }); t.after(() => service.close({ force: true }));
  const origin = `http://127.0.0.1:${service.http.address().port}`;
  const admin = await (await fetch(origin + '/v1/admin', { headers: auth })).json();
  const post = (value = { challenge }, headers = {}) => fetch(origin + '/v1/admin/routing/preflight', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Fogd-CSRF': admin.csrf, ...headers }, body: JSON.stringify(value) });
  return { ...f, service, release, origin, admin, post };
}
test('admin authentication and CSRF protect preflight before any runtime observations', async t => {
  const f = await fixture(t);
  for (const [headers, status] of [[{ authorization: 'Bearer deploy' }, 401], [{ authorization: 'Bearer gateway' }, 401], [{ 'X-Fogd-CSRF': '' }, 403], [{ Origin: 'https://foreign.example' }, 403]]) {
    const response = await f.post({ challenge }, headers); assert.equal(response.status, status); await response.body.cancel();
  }
  assert.equal(f.verifications(), 0);
  const response = await f.post(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json(); assert.equal(result.challenge, challenge); assert.deepEqual(result.observedActiveHosts, ['alpha.localhost']);
  assert.equal(f.verifications(), 1);
});
test('invalid preflight input is a client error and runtime failure is a fixed unavailable response', async t => {
  const f = await fixture(t), invalid = await f.post({ challenge: 'invalid' });
  assert.equal(invalid.status, 400); await invalid.body.cancel(); assert.equal(f.verifications(), 0);
  f.service.controller.routes.options.verifyRuntime = async () => { throw new Error('PRIVATE diagnostic'); };
  const unavailable = await f.post(); assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'HTTP routing preflight is unconfirmed; keep ingress stopped' });
});
test('recovery-only service never exposes preflight even after exact reconciliation', async t => {
  const f = await fixture(t, true), controller = f.service.controller;
  const reconcile = await fetch(f.origin + '/v1/apps/alpha/routing/reconcile', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Fogd-CSRF': f.admin.csrf }, body: JSON.stringify({ deployment: f.release.id, digest: f.release.digest, intent: controller.state.routeAuthority.pending.id }) });
  assert.equal(reconcile.status, 200); await reconcile.body.cancel(); assert.equal(controller.routingStartupComplete, true);
  const before = f.verifications(), response = await f.post(); assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'ROUTE_RECOVERY_ONLY'); assert.equal(f.verifications(), before);
  await assert.rejects(controller.preflightIngress({ challenge }), { code: 'ROUTE_PREFLIGHT_UNCONFIRMED' });
  const { server } = await import('../src/http.mjs');
  assert.throws(() => server(controller, credentials), /restricted routing recovery service/);
  assert.equal(f.verifications(), before);
});
test('lookup-family services have no durable preflight endpoint', async t => {
  const f = await routeController(t), service = await serveController(f.create({ dir: join(f.root, 'lookup'), routeAuthority: null }), credentials, { port: 0, internalPort: 0, host: '127.0.0.1' });
  t.after(() => service.close({ force: true })); const origin = `http://127.0.0.1:${service.http.address().port}`;
  const admin = await (await fetch(origin + '/v1/admin', { headers: auth })).json();
  const response = await fetch(origin + '/v1/admin/routing/preflight', { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Fogd-CSRF': admin.csrf }, body: JSON.stringify({ challenge }) });
  assert.equal(response.status, 404); await response.body.cancel(); assert.equal(f.verifications(), 0);
});

test('preflight refuses non-JSON, oversized and GET requests before native observation', async t => {
  const f = await fixture(t);
  const text = await f.post({ challenge }, { 'Content-Type': 'text/plain' }); assert.equal(text.status, 400); await text.body.cancel();
  const large = await f.post({ challenge, padding: 'x'.repeat(4096) }); assert.equal(large.status, 400); await large.body.cancel();
  const get = await fetch(f.origin + '/v1/admin/routing/preflight', { headers: auth }); assert.equal(get.status, 404); await get.body.cancel();
  assert.equal(f.verifications(), 0);
});
