import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, mkdir, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Backend } from '../src/backend.mjs';
import { startController } from '../src/startup.mjs';
import { policy as runtimePolicy, environment as runtimeEnvironment } from './fixtures/runtime-policy.mjs';
import { claimBackend } from './fixtures/claim-backend.mjs';
import { issueRouteEnrollment } from '../src/route-enrollment.mjs';
import { initializeRouteEnrollment } from '../src/route-initialize.mjs';
import { routeController } from './fixtures/route-controller.mjs';
import { RuntimePolicyError } from '../src/runtime-policy.mjs';

const legacyPolicy = { readPolicy: async () => null };

async function environment(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-startup-')), previous = { ...process.env };
  const signals = Object.fromEntries(['SIGTERM', 'SIGINT'].map(signal => [signal, process.listeners(signal)]));
  Object.assign(process.env, { FOGD_DATA_DIR: join(dir, 'controller'), FOGD_ADMIN_USER: 'admin', FOGD_ADMIN_PASSWORD: 'test-admin', FOGD_GATEWAY_TOKEN: 'test-gateway', FOGD_DEPLOY_TOKEN: 'test-deploy', FOGD_TLS: '0', FOGD_PROFILE: 'local', FOGD_PUBLIC_BIND_ADDRESS: '127.0.0.1', FOGD_CONTROL_BIND: '127.0.0.1', FOGD_CONTROL_PORT: '0', FOGD_INTERNAL_PORT: '0', FOGD_QUEUE_APPS: '0', FOGD_SLOTS: JSON.stringify([{ id: 'one', prefix: 'one', nodes: ['a', 'b'] }]) });
  t.after(async () => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    for (const [signal, before] of Object.entries(signals)) for (const listener of process.listeners(signal)) if (!before.includes(listener)) process.off(signal, listener);
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function initializeStoppedRouting(dir) {
  const input = { profile: runtimePolicy(), binding: 'e'.repeat(64), controller: join(dir, 'controller'), authority: join(dir, 'authority'), enrollment: join(dir, 'enrollment') };
  await mkdir(input.controller, { mode: 0o700 }); await mkdir(input.authority, { mode: 0o755 }); await mkdir(input.enrollment, { mode: 0o700 });
  const grant = await issueRouteEnrollment(input); await initializeRouteEnrollment({ ...input, id: grant.id });
  return { path: join(input.authority, 'routes.json') };
}

test('shared startup keeps the external admin and internal listener separate with an explicitly supplied backend', async t => {
  const dir = await environment(t), backend = claimBackend(dir);
  const { controller, http, internal } = await startController(backend, legacyPolicy);
  await listenAndClose(t, http, internal);
  const auth = { Authorization: `Basic ${Buffer.from('admin:test-admin').toString('base64')}` };
  const external = `http://127.0.0.1:${http.address().port}`, privateURL = `http://127.0.0.1:${internal.address().port}`;
  assert.equal(controller.backend, backend); assert.equal(controller.queueApps, false);
  const response = await fetch(external + '/v1/admin', { headers: auth }); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).apps, {});
  assert.equal((await fetch(external + '/v1/admin')).status, 401);
  assert.equal((await fetch(privateURL + '/v1/admin', { headers: auth })).status, 404);
});

test('startup refuses invalid credentials or fleet configuration before opening controller storage', async t => {
  const dir = await environment(t), backend = claimBackend(dir);
  delete process.env.FOGD_ADMIN_PASSWORD;
  await assert.rejects(startController(backend, legacyPolicy), /FOGD_ADMIN_PASSWORD is required/);
  process.env.FOGD_ADMIN_PASSWORD = 'test-admin'; process.env.FOGD_SLOTS = '[]';
  await assert.rejects(startController(backend, legacyPolicy), /Invalid fleet slots/);
  process.env.FOGD_SLOTS = JSON.stringify([{ id: 'one', prefix: 'one', nodes: ['a', 'b'] }]);
  process.env.FOGD_QUEUE_APPS = 'yes';
  await assert.rejects(startController(backend, legacyPolicy), /FOGD_QUEUE_APPS must be 0 or 1/);
  await assert.rejects(access(join(dir, 'controller')), /ENOENT/);
});

async function listenAndClose(t, ...servers) {
  t.after(async () => { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); });
  for (const server of servers) if (!server.listening) await once(server, 'listening');
}

test('ordinary startup constructs the default backend without experimental cron transport', async t => {
  await environment(t);
  t.mock.method(Backend.prototype, 'owner', async () => null);
  const { controller, http, internal } = await startController(undefined, legacyPolicy);
  await listenAndClose(t, http, internal);
  assert.ok(controller.backend instanceof Backend);
  assert.equal(controller.backend.crons, undefined);
  assert.equal(controller.cronApps, false);
});

test('independent installed policy selects guarded scheduled admission without branching on its label', async t => {
  await environment(t); Object.assign(process.env, runtimeEnvironment());
  t.mock.method(Backend.prototype, 'owner', async () => null);
  for (const admission of ['candidate', 'qualified']) {
    const selected = runtimePolicy(); selected.admission = admission;
    const { controller, http, internal } = await startController(undefined, { readPolicy: async () => selected });
    await listenAndClose(t, http, internal);
    assert.equal(controller.cronApps, true);
    assert.equal(typeof controller.backend.crons.preflightBootstrap, 'function');
  }
});

test('internal scheduled startup refuses a plain backend before creating controller state', async t => {
  const dir = await environment(t);
  await assert.rejects(startController({ owner: async () => null }, { ...legacyPolicy, cronApps: true }), /qualified runtime transport/);
  await assert.rejects(access(join(dir, 'controller')), { code: 'ENOENT' });
});
test('a refused installed policy prevents controller storage initialization', async t => {
  const dir = await environment(t), backend = claimBackend(dir);
  const attempt = startController(backend, { readPolicy: async () => { throw new RuntimePolicyError(); } }).then(async result => {
    await listenAndClose(t, result.http, result.internal); return result;
  });
  await assert.rejects(attempt, { code: 'RUNTIME_POLICY_REFUSED' });
  await assert.rejects(access(join(dir, 'controller')), { code: 'ENOENT' });
});

test('explicit durable startup derives independent policy and opens no legacy internal listener', async t => {
  const dir = await environment(t); Object.assign(process.env, runtimeEnvironment());
  const routing = await initializeStoppedRouting(dir);
  t.mock.method(Backend.prototype, 'owner', async () => null);
  const result = await startController(undefined, { readPolicy: async () => runtimePolicy(), routeAuthority: routing });
  t.after(() => result.close({ force: true }));
  assert.equal(result.internal, null); assert.equal(result.recoveryOnly, false); assert.equal(result.controller.routes.durable, true);
  const record = JSON.parse(await readFile(routing.path, 'utf8'));
  assert.equal(record.revision, '0'); assert.deepEqual(record.routes, []);
  assert.equal(record.installation, result.controller.routes.options.policy.installation);
});
test('explicit routing without an independent installed policy refuses before controller storage writes', async t => {
  const dir = await environment(t);
  await assert.rejects(startController(undefined, { ...legacyPolicy, routeAuthority: { path: join(dir, 'authority/routes.json') } }), { code: 'RUNTIME_POLICY_REFUSED' });
  await assert.rejects(access(join(dir, 'controller')), { code: 'ENOENT' });
});
test('top-level durable startup refuses unenrolled stores without writing or listening', async t => {
  const dir = await environment(t); Object.assign(process.env, runtimeEnvironment());
  const privateDir = join(dir, 'controller'), authority = join(dir, 'authority');
  await mkdir(privateDir, { mode: 0o700 }); await mkdir(authority, { mode: 0o755 });
  await assert.rejects(startController(undefined, { readPolicy: async () => runtimePolicy(), routeAuthority: { path: join(authority, 'routes.json') } }), { code: 'ROUTE_ENROLLMENT_REQUIRED' });
  assert.deepEqual(await readdir(privateDir), []); assert.deepEqual(await readdir(authority), []);
});

test('top-level durable startup enters recovery after a real pending publication without an internal listener', async t => {
  const dir = await environment(t); Object.assign(process.env, runtimeEnvironment());
  const routing = await initializeStoppedRouting(dir);
  const owners = {}, logs = [];
  t.mock.method(console, 'log', message => { logs.push(message); });
  t.mock.method(Backend.prototype, 'owner', async slot => owners[slot.id] || null);
  t.mock.method(Backend.prototype, 'claim', async (slot, app) => { owners[slot.id] = { app }; });
  t.mock.method(Backend.prototype, 'hasDeployment', async () => false);
  t.mock.method(Backend.prototype, 'publish', async () => 'approved-version');
  t.mock.method(Backend.prototype, 'ready', async () => {});
  t.mock.method(Backend.prototype, 'migrate', async () => {});
  t.mock.method(Backend.prototype, 'applied', async () => []);
  const options = { readPolicy: async () => runtimePolicy(), routeAuthority: routing };
  const first = await startController(undefined, options); t.after(() => first.close({ force: true }));
  const f = await routeController(t), release = await f.request('alpha', first.controller);
  const publication = first.controller.routes.publication, write = publication.writePublic;
  t.mock.method(publication, 'writePublic', async (file, record) => { await write(file, record); if (record.routes.some(route => route.state === 'active')) throw new Error('Lost public acknowledgment'); });
  await assert.rejects(first.controller.mutate(release.id, release.digest, 'approve'), /uncertain/);
  await first.close({ force: true });
  const recovered = await startController(undefined, options);
  t.after(() => recovered.close({ force: true }));
  assert.equal(recovered.recoveryOnly, true); assert.equal(recovered.internal, null);
  assert.equal(recovered.controller.state.routeAuthority.pending.kind, 'active');
  assert.ok(logs.some(message => message.includes('keep ingress stopped')));
});
