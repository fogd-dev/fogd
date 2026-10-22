import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile), cli = fileURLToPath(new URL('../bin/fogd.js', import.meta.url));
const id = '00000000-0000-4000-8000-000000000001', digest = 'a'.repeat(64);
const state = { apps: { guestbook: { route: 'paused', uncertain: id } }, deployments: { [id]: { id, app: 'guestbook', digest, status: 'failed', step: 'migrating', error: 'private-sql-response' } }, csrf: 'private-csrf' };
async function fixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-inspect-')); t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], server = createServer((request, response) => { calls.push({ path: request.url, method: request.method, authorization: request.headers.authorization }); response.setHeader('Content-Type', 'application/json'); respond(request, response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { PATH: process.env.PATH, HOME: root, FOGD_HOME: root, FOGD_ENV_FILE: join(root, 'operator.env'), FOGD_SERVER: `http://127.0.0.1:${server.address().port}`, FOGD_ADMIN_PASSWORD: 'private-admin-password', FOGD_DEPLOY_TOKEN: 'private-builder-token' };
  const invoke = (args = ['guestbook'], extra = {}) => exec(process.execPath, [cli, 'admin', 'inspect', ...args], { env: { ...env, ...extra }, timeout: 20000, maxBuffer: 1024 ** 2 });
  return { calls, env, invoke, root };
}
test('real CLI uses one administrator GET and reports the selected app without raw diagnostics', async t => {
  const f = await fixture(t, (_, response) => response.end(JSON.stringify(state)));
  const result = await f.invoke(), report = JSON.parse(result.stdout);
  assert.deepEqual(f.calls, [{ path: '/v1/admin', method: 'GET', authorization: 'Basic ' + Buffer.from('admin:private-admin-password').toString('base64') }]);
  assert.equal(report.app, 'guestbook'); assert.equal(report.routing, 'paused'); assert.equal(report.runtimeHealth, 'not-observed');
  assert.deepEqual(report.uncertainMigration, { id, digest }); assert.equal(report.releases[0].hasPrivateDiagnostic, true);
  assert.equal(result.stderr, ''); assert.equal(result.stdout.includes('private-'), false);
  await assert.rejects(access(join(f.root, 'operator.env')), { code: 'ENOENT' });
  await assert.rejects(access(join(f.root, '.fogd')), { code: 'ENOENT' });
});
for (const args of [[], ['guestbook', 'unexpected'], ['../other'], ['UPPERCASE']]) test(`invalid inspect arguments refuse before HTTP: ${JSON.stringify(args)}`, async t => {
  const f = await fixture(t, (_, response) => response.end(JSON.stringify(state)));
  await assert.rejects(f.invoke(args), error => error.code === 1 && /Usage:|App name/.test(error.stderr) && error.stdout === '');
  assert.deepEqual(f.calls, []);
});
test('a submitter credential cannot substitute for administrator credentials', async t => {
  const f = await fixture(t, (_, response) => response.end(JSON.stringify(state)));
  await assert.rejects(f.invoke(['guestbook'], { FOGD_ADMIN_PASSWORD: '' }), error => error.code === 1 && /Set FOGD_ADMIN_PASSWORD/.test(error.stderr) && !error.stderr.includes('private-builder-token'));
  assert.deepEqual(f.calls, []);
});
for (const [status, message] of [[401, /authentication was refused/], [403, /authentication was refused/], [503, /state is unavailable \(HTTP 503\)/]]) test(`HTTP ${status} body stays private`, async t => {
  const f = await fixture(t, (_, response) => { response.statusCode = status; response.end(JSON.stringify({ error: 'private-server-error private-admin-password' })); });
  await assert.rejects(f.invoke(), error => error.code === 1 && message.test(error.stderr) && !error.stderr.includes('private-') && error.stdout === '');
  assert.equal(f.calls.length, 1);
});
for (const [name, body, message] of [['invalid JSON', 'private-not-json', /unreadable JSON/], ['oversized state', 'private-response' + 'x'.repeat(4 * 1024 ** 2), /exceeded the 4 MiB/]]) test(`${name} never becomes diagnostic output`, async t => {
  const f = await fixture(t, (_, response) => response.end(body));
  await assert.rejects(f.invoke(), error => error.code === 1 && message.test(error.stderr) && !error.stderr.includes('private-') && error.stdout === '');
  assert.equal(f.calls.length, 1);
});
test('an unsupported successful response cannot masquerade as recorded application state', async t => {
  const f = await fixture(t, (_, response) => response.end(JSON.stringify({ secrets: 'private-response' })));
  await assert.rejects(f.invoke(), error => error.code === 1 && /unsupported application state/.test(error.stderr) && !error.stderr.includes('private-response') && error.stdout === '');
});
test('administrator redirects are refused without forwarding credentials to another destination', async t => {
  const target = await fixture(t, (_, response) => response.end(JSON.stringify(state)));
  const f = await fixture(t, (_, response) => { response.statusCode = 302; response.setHeader('Location', target.env.FOGD_SERVER + '/private-redirect'); response.end(); });
  await assert.rejects(f.invoke(), error => error.code === 1 && /Cannot read controller state/.test(error.stderr) && !error.stderr.includes('private-redirect') && error.stdout === '');
  assert.equal(f.calls.length, 1); assert.deepEqual(target.calls, []);
});

test('a non-JSON content type is rejected even if its bytes look like controller state', async t => {
  const f = await fixture(t, (_, response) => { response.setHeader('Content-Type', 'text/html'); response.end(JSON.stringify(state)); });
  await assert.rejects(f.invoke(), error => error.code === 1 && /did not return JSON/.test(error.stderr) && error.stdout === '');
});
