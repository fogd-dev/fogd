import test from 'node:test';
import { runtimeCli } from './fixtures/runtime-cli.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile), cli = new URL('../bin/fogd.js', import.meta.url).pathname;
const id = '00000000-0000-4000-8000-000000000001';
const release = { id, app: 'guestbook', digest: 'a'.repeat(64), status: 'failed', step: 'migrating', submittedAt: '2026-10-22T12:00:00.000Z' };
async function fixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-status-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], server = createServer((request, response) => {
    calls.push({ path: request.url, method: request.method, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json'); respond(request, response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { PATH: process.env.PATH, HOME: root, FOGD_HOME: root, FOGD_ENV_FILE: join(root, 'absent.env'), FOGD_SERVER: `http://127.0.0.1:${server.address().port}`, FOGD_DEPLOY_TOKEN: 'private-deploy-token', FOGD_ADMIN_PASSWORD: 'private-admin-password' };
  return { env, root, calls, invoke: (args = [id], extra = {}) => exec(process.execPath, [cli, 'status', ...args], { env: { ...env, ...extra }, timeout: 20000 }) };
}
test('real status CLI makes one deploy-authenticated GET and emits only the requested public release', async t => {
  const f = await fixture(t, (_, response) => response.end(JSON.stringify({ ...release, error: 'private-sql-error', otherApp: 'private-other-app', credentials: 'private-deploy-token' })));
  const result = await f.invoke(), report = JSON.parse(result.stdout);
  assert.deepEqual(f.calls, [{ path: `/v1/deployments/${id}`, method: 'GET', authorization: 'Bearer private-deploy-token' }]);
  assert.deepEqual(report, { ...release, error: 'A database migration failed or was interrupted. Ask an administrator to inspect the migration before retrying.' });
  assert.equal(result.stderr, ''); assert.equal(result.stdout.includes('private-'), false);
  await assert.rejects(access(join(f.root, '.fogd')), { code: 'ENOENT' });
});
for (const args of [[], ['invalid'], ['../escape'], [id, 'extra']]) test(`invalid status arguments refuse before HTTP: ${JSON.stringify(args)}`, async t => {
  const f = await fixture(t, (_, response) => response.end('{}'));
  await assert.rejects(f.invoke(args), error => error.code === 1 && /Usage:/.test(error.stderr)); assert.deepEqual(f.calls, []);
});
test('administrator credentials cannot substitute for a missing deploy token', async t => {
  const f = await fixture(t, (_, response) => response.end('{}'));
  await assert.rejects(f.invoke([id], { FOGD_DEPLOY_TOKEN: '' }), error => /Set FOGD_DEPLOY_TOKEN/.test(error.stderr) && !error.stderr.includes('private-admin-password'));
  assert.deepEqual(f.calls, []);
});
for (const [code, message] of [[401, /authentication was refused/], [403, /authentication was refused/], [404, /unavailable to this deploy credential/], [503, /unavailable \(HTTP 503\)/]]) test(`HTTP ${code} never prints private response contents`, async t => {
  const f = await fixture(t, (_, response) => { response.statusCode = code; response.end(JSON.stringify({ error: 'private-deploy-token private-runtime-error' })); });
  await assert.rejects(f.invoke(), error => error.code === 1 && message.test(error.stderr) && !error.stderr.includes('private-') && error.stdout === '');
  assert.equal(f.calls.length, 1);
});
for (const [name, body, message] of [['malformed JSON', 'private-json', /unreadable JSON/], ['oversized body', 'private-json' + 'x'.repeat(65536), /64 KiB/], ['wrong identity', JSON.stringify({ ...release, id: '00000000-0000-4000-8000-000000000002' }), /different submission/], ['unsupported shape', JSON.stringify({ secrets: 'private-secret' }), /invalid/]]) test(`${name} refuses without echoing response data`, async t => {
  const f = await fixture(t, (_, response) => response.end(body));
  await assert.rejects(f.invoke(), error => error.code === 1 && message.test(error.stderr) && !error.stderr.includes('private-') && error.stdout === '');
});
test('a same-origin redirect refuses instead of forwarding the token to another path', async t => {
  const f = await fixture(t, (_, response) => { response.statusCode = 302; response.setHeader('Location', '/private-control'); response.end(); });
  await assert.rejects(f.invoke(), error => /Cannot read submission status/.test(error.stderr) && !error.stderr.includes('private-control'));
  assert.equal(f.calls.length, 1);
});
test('a cross-origin redirect is never contacted', async t => {
  const target = await fixture(t, (_, response) => response.end(JSON.stringify(release)));
  const f = await fixture(t, (_, response) => { response.statusCode = 302; response.setHeader('Location', target.env.FOGD_SERVER + '/private-control'); response.end(); });
  await assert.rejects(f.invoke(), error => /Cannot read submission status/.test(error.stderr)); assert.deepEqual(target.calls, []);
});
test('a misleading content type refuses even when its bytes look like JSON', async t => {
  const f = await fixture(t, (_, response) => { response.setHeader('Content-Type', 'text/html'); response.end(JSON.stringify(release)); });
  await assert.rejects(f.invoke(), error => /did not return JSON/.test(error.stderr) && error.stdout === '');
});
test('a disconnected response is an interrupted status read', async t => {
  const f = await fixture(t, (_, response) => { response.writeHead(200); response.flushHeaders(); response.write('{"private":'); response.socket.destroy(); });
  await assert.rejects(f.invoke(), error => /interrupted|Cannot read submission status/.test(error.stderr) && !error.stderr.includes('private') && error.stdout === '');
});

test('a valid response exactly at the 64 KiB limit is accepted while padding stays private', async t => {
  const input = { ...release, padding: '' }, bytes = Buffer.byteLength(JSON.stringify(input));
  input.padding = 'x'.repeat(65536 - bytes); const body = JSON.stringify(input); assert.equal(Buffer.byteLength(body), 65536);
  const f = await fixture(t, (_, response) => response.end(body));
  const output = JSON.parse((await f.invoke()).stdout);
  assert.equal(output.id, id); assert.equal(Object.hasOwn(output, 'padding'), false);
});

test('a copied CLI resolves the declared platform dependency and reads status outside the checkout', async t => {
  const f = await fixture(t, (_, response) => response.end(JSON.stringify(release)));
  const copied = await runtimeCli(f.root, 'qualified');
  const result = await exec(process.execPath, [copied.cli, 'status', id], { cwd: f.root, env: f.env, timeout: 20000 });
  assert.equal(JSON.parse(result.stdout).id, id); assert.equal(result.stderr, ''); assert.equal(f.calls.length, 1);
});
