import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Backend } from '../src/backend.mjs';
import { startController } from '../src/startup.mjs';
import { claimBackend } from './fixtures/claim-backend.mjs';

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

test('shared startup keeps the external admin and internal listener separate with an explicitly supplied backend', async t => {
  const dir = await environment(t), backend = claimBackend(dir);
  const { controller, http, internal } = await startController(backend);
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
  await assert.rejects(startController(backend), /FOGD_ADMIN_PASSWORD is required/);
  process.env.FOGD_ADMIN_PASSWORD = 'test-admin'; process.env.FOGD_SLOTS = '[]';
  await assert.rejects(startController(backend), /Invalid fleet slots/);
  process.env.FOGD_SLOTS = JSON.stringify([{ id: 'one', prefix: 'one', nodes: ['a', 'b'] }]);
  process.env.FOGD_QUEUE_APPS = 'yes';
  await assert.rejects(startController(backend), /FOGD_QUEUE_APPS must be 0 or 1/);
  await assert.rejects(access(join(dir, 'controller')), /ENOENT/);
});

async function listenAndClose(t, ...servers) {
  t.after(async () => { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); });
  for (const server of servers) if (!server.listening) await once(server, 'listening');
}

test('ordinary startup constructs the default backend without experimental cron transport', async t => {
  await environment(t);
  t.mock.method(Backend.prototype, 'owner', async () => null);
  const { controller, http, internal } = await startController();
  await listenAndClose(t, http, internal);
  assert.ok(controller.backend instanceof Backend);
  assert.equal(controller.backend.crons, undefined);
});
