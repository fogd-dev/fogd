import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { routeController } from './fixtures/route-controller.mjs';
import { serveController } from '../src/controller-service.mjs';

const credentials = { user: 'admin', password: 'password', deploy: 'deploy', gateway: 'gateway' };
const auth = { authorization: `Basic ${Buffer.from('admin:password').toString('base64')}` };
async function open(t, controller, options = {}) {
  const service = await serveController(controller, credentials, { port: 0, internalPort: 0, host: '127.0.0.1', ...options });
  t.after(() => service.close({ force: true }));
  const origin = `http://127.0.0.1:${service.http.address().port}`;
  const admin = await (await fetch(origin + '/v1/admin', { headers: auth })).json();
  const post = (path, input = {}, headers = {}) => fetch(origin + path, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Fogd-CSRF': admin.csrf, ...headers }, body: JSON.stringify(input) });
  return { ...service, origin, admin, post };
}
async function pending(t) {
  const f = await routeController(t), release = await f.request();
  f.failPublic(record => record.routes[0]?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(release.id, release.digest, 'approve'), /uncertain/); f.failPublic(null);
  return { ...f, release };
}
test('pending publication opens only authenticated recovery and stays restricted after exact reconciliation', async t => {
  const f = await pending(t), service = await open(t, f.create());
  assert.equal(service.recoveryOnly, true); assert.equal(service.internal, null);
  assert.equal(service.admin.recoveryOnly, true); assert.equal(service.admin.routingStartupComplete, false); assert.equal(service.admin.ingress, 'keep-stopped');
  const unauthenticated = await fetch(service.origin + '/v1/admin'); assert.equal(unauthenticated.status, 401); await unauthenticated.body.cancel();
  const input = { deployment: f.release.id, digest: f.release.digest, intent: service.controller.state.routeAuthority.pending.id };
  const denied = await service.post('/v1/apps/alpha/routing/reconcile', input, { authorization: 'Bearer deploy' }); assert.equal(denied.status, 401); await denied.body.cancel();
  const csrf = await service.post('/v1/apps/alpha/routing/reconcile', input, { 'X-Fogd-CSRF': '' }); assert.equal(csrf.status, 403); await csrf.body.cancel();
  const before = [...f.events], response = await service.post('/v1/apps/alpha/routing/reconcile', input);
  assert.equal(response.status, 200); assert.equal((await response.json()).state, 'active');
  assert.equal(f.verifications(), 1); assert.deepEqual(f.events, before); assert.equal(service.controller.routingStartupComplete, true);
  for (const path of ['/v1/deployments', `/v1/deployments/${f.release.id}/approve`, '/v1/credentials', '/v1/apps/alpha/secrets', '/v1/apps/alpha/routing/resume']) {
    const result = await service.post(path); assert.equal(result.status, 503); assert.equal((await result.json()).code, 'ROUTE_RECOVERY_ONLY');
  }
  const status = await (await fetch(service.origin + '/v1/admin', { headers: auth })).json();
  assert.equal(status.recoveryOnly, true); assert.equal(status.routingStartupComplete, true); assert.equal(status.ingress, 'keep-stopped');
  assert.deepEqual(f.events, before);
});
test('recovery service permits exact pending withdrawal without runtime or backend writes', async t => {
  const f = await pending(t), service = await open(t, f.create());
  const response = await service.post('/v1/apps/alpha/routing/withhold-pending', { deployment: f.release.id, digest: f.release.digest, intent: service.controller.state.routeAuthority.pending.id });
  assert.equal(response.status, 200); assert.equal((await response.json()).state, 'withheld'); assert.equal(f.verifications(), 0);
  assert.equal(service.recoveryOnly, true); assert.equal(service.controller.routingStartupComplete, true);
});
test('settled durable startup opens normal admin but no internal route listener', async t => {
  const f = await routeController(t), service = await open(t, f.create());
  assert.equal(service.recoveryOnly, false); assert.equal(service.internal, null);
  assert.equal(service.controller.routingStartupComplete, true); assert.equal(service.admin.recoveryOnly, undefined);
});
test('missing retained authority refuses before opening a recovery listener', async t => {
  const f = await routeController(t); await rm(f.path);
  await assert.rejects(serveController(f.create(), credentials, { port: 0, host: '127.0.0.1' }), /uncertain/);
});
test('failure before ownership inspection cannot expose recovery mutations', async t => {
  const f = await pending(t), stateFile = join(f.dir, 'state.json'), state = JSON.parse(await readFile(stateFile, 'utf8'));
  state.deployments[f.release.id].step = 'publishing'; await writeFile(stateFile, JSON.stringify(state));
  const controller = f.create();
  await assert.rejects(serveController(controller, credentials, { port: 0, host: '127.0.0.1' }), { code: 'ROUTE_STARTUP_UNRECONCILED' });
  assert.equal(controller.routingRecoveryAvailable, false);
});
test('a listener collision leaves the unrelated listener alone and no service running', async t => {
  const blocker = createServer(); await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => blocker.close(resolve)));
  const f = await routeController(t);
  await assert.rejects(serveController(f.create(), credentials, { port: blocker.address().port, host: '127.0.0.1' }), { code: 'EADDRINUSE' });
  assert.equal(blocker.listening, true);
});

test('typed routing failure after ownership inspection opens recovery and reconciles the blocked peer', async t => {
  const f = await routeController(t), alpha = await f.request(), beta = await f.request('beta');
  await f.c.mutate(alpha.id, alpha.digest, 'approve'); await f.c.mutate(beta.id, beta.digest, 'approve');
  const update = await f.request(); f.failPublic(record => record.routes.find(route => route.host === 'alpha.localhost')?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(update.id, update.digest, 'approve'), /uncertain/); f.failPublic(null); f.owners['slot-2'] = null;
  const service = await open(t, f.create()), before = [...f.events];
  assert.equal(service.recoveryOnly, true); assert.equal(service.controller.routingRecoveryAvailable, true); assert.equal(service.controller.routingStartupComplete, false);
  assert.equal((await f.public()).routes.find(route => route.host === 'beta.localhost').state, 'active');
  const response = await service.post('/v1/apps/alpha/routing/reconcile', { deployment: update.id, digest: update.digest, intent: service.controller.state.routeAuthority.pending.id });
  assert.equal(response.status, 200); await response.body.cancel();
  assert.equal((await f.public()).routes.find(route => route.host === 'beta.localhost').state, 'withheld');
  assert.equal(service.controller.routingStartupComplete, true); assert.equal(service.recoveryOnly, true); assert.deepEqual(f.events, before);
});
test('recovery route read failures return 503 through the service error handler', async t => {
  const f = await pending(t), service = await open(t, f.create()); await rm(f.path);
  const response = await fetch(service.origin + '/v1/apps/alpha/routing', { headers: auth });
  assert.equal(response.status, 503); assert.match((await response.json()).error, /uncertain/);
});
test('internal listener failure closes the newly opened public listener and preserves the blocker', async t => {
  const blocker = createServer(); await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => blocker.close(resolve)));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const f = await routeController(t), legacy = f.create({ dir: join(f.root, 'legacy-private'), routeAuthority: null });
  await assert.rejects(serveController(legacy, credentials, { port, internalPort: blocker.address().port, host: '127.0.0.1' }), { code: 'EADDRINUSE' });
  assert.equal(blocker.listening, true);
  const reuse = createServer(); await new Promise((resolve, reject) => { reuse.once('error', reject); reuse.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => reuse.close(resolve));
});

test('direct HTTP construction cannot bypass recovery mode on an unreconciled durable controller', async t => {
  const f = await pending(t), controller = f.create(); await controller.init();
  const { server } = await import('../src/http.mjs');
  assert.throws(() => server(controller, credentials), /restricted routing recovery service/);
  const uninspected = f.create(); assert.throws(() => server(uninspected, credentials, { recoveryOnly: true }), /inspected durable ownership/);
});
test('divergent ownership can expose diagnostic-only recovery while requiring stopped repair', async t => {
  const f = await routeController(t), release = await f.request(); await f.c.mutate(release.id, release.digest, 'approve');
  f.c.state.apps.alpha.slot = 'slot-2'; await f.c.save();
  const service = await open(t, f.create());
  assert.equal(service.recoveryOnly, true); assert.equal(service.controller.routingStartupComplete, false);
  const view = await fetch(service.origin + '/v1/apps/alpha/routing', { headers: auth });
  assert.equal(view.status, 200); assert.equal((await view.json()).state, 'withheld');
  const response = await service.post('/v1/apps/alpha/routing/reconcile', { deployment: release.id, digest: release.digest, intent: 'active:missing' });
  assert.equal(response.status, 400); await response.body.cancel();
  assert.equal(service.controller.routingStartupComplete, false);
});
test('an unrelated storage failure after ownership inspection refuses instead of opening recovery', async t => {
  const f = await routeController(t); f.failPrivate(file => file.endsWith('/state.json') ? 'before' : null);
  const controller = f.create();
  await assert.rejects(serveController(controller, credentials, { port: 0, host: '127.0.0.1' }), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
  assert.equal(controller.routingRecoveryAvailable, true); assert.equal(controller.routingStartupComplete, false);
});

test('exact reconciliation performs held-queue pause recovery behind withholding without replaying activation', async t => {
  const [{ queues }, { requireQueueCapability }, { artifactDigest }] = await Promise.all([
    import('./fixtures/queue-controller.mjs'), import('../src/queue-activation.mjs'), import('@fogd/runtime/artifact'),
  ]);
  const f = await routeController(t), queueEvents = [];
  f.backend.bootstrap = async slot => {
    assert.equal((await f.public()).routes.find(route => route.slot === slot.id).state, 'withheld');
    return f.versions[slot.id] = 'bootstrap';
  };
  f.backend.queues = {
    async pause(slot) { assert.equal((await f.public()).routes.find(route => route.slot === slot.id).state, 'withheld'); queueEvents.push('pause'); return { paused: true }; },
    async resume() { throw new Error('Startup must not release queue delivery'); },
  };
  const controller = f.create({ queueApps: true }); await controller.init();
  const queued = await f.request('imports', controller), artifact = controller.artifact(queued.id), configPath = join(artifact, 'wrangler.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')); config.queues = queues; await writeFile(configPath, JSON.stringify(config));
  queued.resources.queues = queues; queued.digest = await artifactDigest(artifact); requireQueueCapability(controller.state, queued.resources); await controller.save();
  f.fail('migrate'); await controller.mutate(queued.id, queued.digest, 'approve');
  assert.equal(queued.status, 'failed'); assert.equal(controller.state.apps.imports.delivery.hold, queued.id);
  const alpha = await f.request('alpha', controller); await controller.mutate(alpha.id, alpha.digest, 'approve');
  const update = await f.request('alpha', controller); f.failPublic(record => record.routes.find(route => route.host === 'alpha.localhost')?.state === 'active' ? 'after' : null);
  await assert.rejects(controller.mutate(update.id, update.digest, 'approve'), /uncertain/); f.failPublic(null);
  const pauses = queueEvents.length, service = await open(t, f.create({ queueApps: true })), before = f.events.length;
  assert.equal(service.recoveryOnly, true); assert.equal(queueEvents.length, pauses);
  const response = await service.post('/v1/apps/alpha/routing/reconcile', { deployment: update.id, digest: update.digest, intent: service.controller.state.routeAuthority.pending.id });
  assert.equal(response.status, 200); await response.body.cancel();
  assert.deepEqual(f.events.slice(before).map(event => event.kind), ['ready']);
  assert.deepEqual(queueEvents.slice(pauses), ['pause']);
  assert.equal(service.controller.state.apps.imports.delivery.hold, queued.id);
  assert.equal(service.controller.state.deployments[queued.id].status, 'failed');
  assert.equal((await f.public()).routes.find(route => route.host === 'imports.localhost').state, 'withheld');
  assert.equal(service.recoveryOnly, true);
});

test('recovery rejects valid credential, secret and approval payloads after reconciliation', async t => {
  const f = await pending(t), service = await open(t, f.create());
  const reconcile = await service.post('/v1/apps/alpha/routing/reconcile', { deployment: f.release.id, digest: f.release.digest, intent: service.controller.state.routeAuthority.pending.id });
  assert.equal(reconcile.status, 200); await reconcile.body.cancel();
  const next = await f.request('alpha', service.controller), effects = [...f.events];
  const priorCredentials = service.controller.credentials.describe(), priorSecrets = service.controller.secrets.describe();
  const issued = await service.post('/v1/credentials', { name: 'valid-scope', apps: ['alpha'] });
  assert.equal(issued.status, 503); await issued.body.cancel();
  const secret = await fetch(service.origin + '/v1/apps/alpha/secrets', { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json', 'X-Fogd-CSRF': service.admin.csrf }, body: JSON.stringify({ API_KEY: 'fixture-value' }) });
  assert.equal(secret.status, 503); await secret.body.cancel();
  const approval = await service.post(`/v1/deployments/${next.id}/approve`, { digest: next.digest });
  assert.equal(approval.status, 503); await approval.body.cancel();
  assert.deepEqual(service.controller.credentials.describe(), priorCredentials); assert.deepEqual(service.controller.secrets.describe(), priorSecrets);
  assert.equal(next.status, 'pending'); assert.deepEqual(f.events, effects);
  const pause = await service.post('/v1/apps/alpha/routing/pause', { deployment: f.release.id, digest: f.release.digest });
  assert.equal(pause.status, 200); assert.equal((await pause.json()).state, 'withheld');
});
