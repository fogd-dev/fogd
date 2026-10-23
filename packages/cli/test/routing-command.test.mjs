import test from 'node:test';
import assert from 'node:assert/strict';
import { adminCliFixture } from './fixtures/admin-client.mjs';

const id = '00000000-0000-4000-8000-000000000001', digest = 'a'.repeat(64), csrf = 'c'.repeat(64);
const selection = { deployment: id, digest };
const reply = (state = 'active') => ({ app: 'alpha', state, revision: '12', active: state === 'active' ? selection : null, hold: null, startupBlocked: false, pending: null });
const fixture = (t, respond) => adminCliFixture(t, { respond, command: 'routing', defaults: ['alpha'] });

for (const action of ['pause', 'resume', 'reconcile', 'withhold-pending']) test(`real CLI ${action} selects one exact approval and publication without replay`, async t => {
  const state = ['resume', 'reconcile'].includes(action) ? 'active' : 'withheld';
  const pending = ['reconcile', 'withhold-pending'].includes(action), intent = 'active:12';
  let body = '', headers;
  const f = await fixture(t, (request, response) => {
    if (request.url === '/v1/admin') { response.end(JSON.stringify({ csrf })); return; }
    headers = request.headers; request.on('data', chunk => { body += chunk; });
    request.on('end', () => response.end(JSON.stringify({ ...reply(state), error: 'private-error' })));
  });
  const result = await f.invoke(['alpha', action, id, digest, ...(pending ? [intent] : [])]);
  assert.deepEqual(JSON.parse(result.stdout), { schema: 1, ...reply(state) }); assert.equal(result.stderr, '');
  assert.deepEqual(f.calls.map(call => [call.method, call.path]), [['GET', '/v1/admin'], ['POST', `/v1/apps/alpha/routing/${action}`]]);
  assert.ok(f.calls.every(call => call.authorization === 'Basic ' + Buffer.from('admin:private-admin-password').toString('base64')));
  assert.equal(headers['x-fogd-csrf'], csrf); assert.deepEqual(JSON.parse(body), { ...selection, ...(pending ? { intent } : {}) });
  assert.doesNotMatch(result.stdout, /private-|csrf/);
});

test('routing status reports holds and pending publication using only checked public fields', async t => {
  const raw = { ...reply('withheld'), hold: { id, digest, secret: 'private-secret' }, startupBlocked: true,
    pending: { intent: 'active:13', kind: 'active', app: 'alpha', approval: { id, digest, error: 'private-error' } }, error: 'private-error' };
  const f = await fixture(t, (_, response) => response.end(JSON.stringify(raw)));
  const result = await f.invoke();
  assert.deepEqual(JSON.parse(result.stdout), { schema: 1, app: 'alpha', state: 'withheld', revision: '12', active: null, hold: selection, startupBlocked: true,
    pending: { intent: 'active:13', kind: 'active', app: 'alpha', approval: selection } });
  assert.deepEqual(f.calls.map(call => [call.method, call.path]), [['GET', '/v1/apps/alpha/routing']]);
  assert.doesNotMatch(result.stdout, /private-/);
});

for (const args of [[], ['../alpha'], ['alpha', 'pause'], ['alpha', 'pause', '../id', digest], ['alpha', 'resume', id, 'bad'],
  ['alpha', 'reconcile', id, digest], ['alpha', 'reconcile', id, digest, 'withhold:12'], ['alpha', 'pause', id, digest, 'extra'], ['alpha', 'status', id]]) test(`invalid routing arguments refuse before HTTP: ${JSON.stringify(args)}`, async t => {
  const f = await fixture(t, (_, response) => response.end('private-error'));
  await assert.rejects(f.invoke(args), error => error.code === 1 && error.stdout === '' && !error.stderr.includes('private-error'));
  assert.deepEqual(f.calls, []);
});

test('missing owner password and invalid CSRF prevent routing mutations', async t => {
  const f = await fixture(t, (_, response) => response.end(JSON.stringify({ csrf: 'private-error' })));
  await assert.rejects(f.invoke(['alpha', 'pause', id, digest], { FOGD_ADMIN_PASSWORD: '' }), /FOGD_ADMIN_PASSWORD/); assert.deepEqual(f.calls, []);
  await assert.rejects(f.invoke(['alpha', 'pause', id, digest]), error => /was not sent/.test(error.stderr) && !error.stderr.includes('private-error'));
  assert.deepEqual(f.calls.map(call => call.method), ['GET']);
});

for (const [name, status, body] of [
  ['server failure', 503, 'private-error'], ['refused decision', 400, 'private-error'], ['invalid JSON', 200, 'private-error'],
  ['wrong app', 200, JSON.stringify({ ...reply(), app: 'beta' })], ['wrong approval', 200, JSON.stringify({ ...reply(), active: { ...selection, digest: 'b'.repeat(64) } })],
  ['still withheld', 200, JSON.stringify(reply('withheld'))], ['startup blocked', 200, JSON.stringify({ ...reply(), startupBlocked: true })],
  ['pending publication', 200, JSON.stringify({ ...reply(), pending: { intent: 'active:13', kind: 'active', app: 'alpha', approval: { id, digest } } })],
  ['oversized reply', 200, 'x'.repeat(65537)],
]) test(`${name} after resume stays uncertain and is never retried`, async t => {
  const f = await fixture(t, (request, response) => {
    if (request.method === 'GET') { response.end(JSON.stringify({ csrf })); return; }
    response.statusCode = status; response.end(body);
  });
  await assert.rejects(f.invoke(['alpha', 'resume', id, digest]), error => error.code === 1 && /HTTP routing decision is uncertain/.test(error.stderr) && !error.stderr.includes('private-error') && error.stdout === '');
  assert.equal(f.calls.length, 2);
});

test('lost routing reply is uncertain without replaying the pause', async t => {
  const f = await fixture(t, (request, response) => {
    if (request.method === 'GET') response.end(JSON.stringify({ csrf })); else response.destroy();
  });
  await assert.rejects(f.invoke(['alpha', 'pause', id, digest]), error => /decision is uncertain/.test(error.stderr) && error.stdout === '');
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST']);
});

test('a routing redirect cannot forward owner credentials or replay a decision', async t => {
  const target = await fixture(t, (_, response) => response.end(JSON.stringify(reply())));
  const f = await fixture(t, (request, response) => {
    if (request.method === 'GET') response.end(JSON.stringify({ csrf })); else { response.statusCode = 307; response.setHeader('Location', target.env.FOGD_SERVER); response.end(); }
  });
  await assert.rejects(f.invoke(['alpha', 'resume', id, digest]), error => /decision is uncertain/.test(error.stderr));
  assert.equal(f.calls.length, 2); assert.deepEqual(target.calls, []);
});

for (const [label, status, body] of [['unsupported', 404, 'private-error'], ['unauthorized', 401, 'private-error'], ['invalid', 200, 'private-error'],
  ['oversized', 200, 'x'.repeat(65537)], ['wrong app', 200, JSON.stringify({ ...reply(), app: 'beta' })]]) test(`routing status ${label} withholds private response contents`, async t => {
  const f = await fixture(t, (_, response) => { response.statusCode = status; response.end(body); });
  await assert.rejects(f.invoke(), error => error.code === 1 && error.stdout === '' && !error.stderr.includes('private-error'));
  assert.equal(f.calls.length, 1);
});

async function controllerClient(t, f, controller = f.c, recoveryOnly = false) {
  const [{ server }, { execFile }, { promisify }, { join }] = await Promise.all([
    import('../../platform/src/http.mjs'), import('node:child_process'), import('node:util'), import('node:path'),
  ]);
  const http = server(controller, { user: 'admin', password: 'private-admin-password', deploy: 'deploy', gateway: 'gateway' }, { recoveryOnly });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  return async args => JSON.parse((await promisify(execFile)(process.execPath, [new URL('../bin/fogd.js', import.meta.url).pathname, 'admin', 'routing', 'alpha', ...args], {
    env: { PATH: process.env.PATH, HOME: f.root, FOGD_HOME: f.root, FOGD_ENV_FILE: join(f.root, 'absent.env'), FOGD_SERVER: `http://127.0.0.1:${http.address().port}`, FOGD_ADMIN_PASSWORD: 'private-admin-password' }, timeout: 15000,
  })).stdout);
}

test('CLI pauses and verifies resume against the real durable controller and authority files', async t => {
  const { routeController } = await import('../../platform/test/fixtures/route-controller.mjs');
  const f = await routeController(t), request = await f.request(); await f.c.mutate(request.id, request.digest, 'approve');
  const invoke = await controllerClient(t, f);
  const paused = await invoke(['pause', request.id, request.digest]); assert.equal(paused.state, 'withheld'); assert.equal((await f.public()).routes[0].state, 'withheld');
  const resumed = await invoke(['resume', request.id, request.digest]); assert.equal(resumed.state, 'active'); assert.deepEqual(resumed.active, { deployment: request.id, digest: request.digest });
  assert.equal((await f.public()).routes[0].state, 'active'); assert.equal(f.verifications(), 1);
});

for (const action of ['reconcile', 'withhold-pending']) test(`CLI ${action} resolves the exact interrupted publication through the restricted controller`, async t => {
  const { routeController } = await import('../../platform/test/fixtures/route-controller.mjs');
  const f = await routeController(t), request = await f.request();
  f.failPublic(record => record.routes[0]?.state === 'active' ? 'after' : null);
  await assert.rejects(f.c.mutate(request.id, request.digest, 'approve'), /uncertain/); f.failPublic(null);
  const controller = f.create(); await controller.init();
  const invoke = await controllerClient(t, f, controller, true), before = [...f.events];
  const status = await invoke(['status']); assert.equal(status.pending.kind, 'active');
  const result = await invoke([action, request.id, request.digest, status.pending.intent]);
  const state = action === 'reconcile' ? 'active' : 'withheld';
  assert.equal(result.state, state); assert.equal(result.pending, null); assert.equal((await f.public()).routes[0].state, state);
  assert.deepEqual(f.events, before); assert.equal(f.verifications(), action === 'reconcile' ? 1 : 0);
});
