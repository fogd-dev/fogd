import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkGateway, validateCheckPath } from '../src/check/worker.mjs';

const worker = new URL('../src/check/worker.mjs', import.meta.url).pathname;
const input = (overrides = {}) => ({ address: '127.0.0.1', host: 'app-a.test', tls: false, path: '/health', ca: null, ...overrides });
const timeout = { httpStatus: null, headersMs: null, reason: 'timeout' };
const unavailable = { httpStatus: null, headersMs: null, reason: 'transport-unavailable' };

async function listen(t, server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return server.address().port;
}
function app(t, handler) {
  const requests = [];
  return listen(t, http.createServer((request, response) => { requests.push({ url: request.url, method: request.method, headers: request.headers }); handler(request, response, requests); }))
    .then(port => ({ port, requests }));
}
function assertOk(result, status) {
  assert.deepEqual(Object.keys(result), ['httpStatus', 'headersMs', 'reason']);
  assert.equal(result.httpStatus, status); assert.equal(result.reason, null); assert.ok(Number.isInteger(result.headersMs) && result.headersMs >= 0);
}

test('reports 503 then 200 as raw status without reading the body, headers or secrets', async t => {
  const unread = [], statuses = [503, 200], f = await app(t, (request, response) => {
    response.writeHead(statuses.shift(), { 'set-cookie': 'PRIVATE_COOKIE=1', 'x-private': 'PRIVATE_HEADER' }); response.flushHeaders();
    unread.push(new Promise(resolve => response.once('close', () => resolve(!response.writableEnded))));
  });
  const first = await checkGateway(input(), { port: f.port }), second = await checkGateway(input(), { port: f.port });
  assertOk(first, 503); assertOk(second, 200);
  assert.deepEqual(await Promise.all(unread), [true, true]);
  assert.equal(JSON.stringify([first, second]).includes('PRIVATE'), false);
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    assert.equal(request.method, 'GET'); assert.equal(request.url, '/health');
    assert.equal(request.headers.authorization, undefined); assert.equal(request.headers.cookie, undefined);
  }
});

test('reports a redirect without following or replaying it', async t => {
  const f = await app(t, (request, response) => { response.writeHead(302, { location: '/elsewhere' }); response.end(); });
  assertOk(await checkGateway(input(), { port: f.port }), 302);
  assert.deepEqual(f.requests.map(request => request.url), ['/health']);
});

test('sends the explicit application Host so two apps on one gateway stay isolated', async t => {
  const f = await app(t, (request, response) => { response.writeHead(request.headers.host === 'app-a.test' ? 200 : 404); response.end(); });
  assertOk(await checkGateway(input(), { port: f.port }), 200);
  assertOk(await checkGateway(input({ host: 'app-b.test' }), { port: f.port }), 404);
  assert.deepEqual(f.requests.map(request => request.headers.host), ['app-a.test', 'app-b.test']);
});

test('times out with an absolute deadline when headers never arrive', async t => {
  const f = await app(t, () => {});
  const timers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length, before = timers();
  const start = performance.now(), result = await checkGateway(input(), { port: f.port, timeoutMs: 200 });
  assert.deepEqual(result, timeout); assert.ok(performance.now() - start < 2000); assert.equal(timers(), before);
});

test('trickling connection cannot extend the deadline past socket-idle resets', async t => {
  const port = await listen(t, net.createServer(socket => { socket.on('error', () => {}); socket.write('HTTP/1.1 200 OK\r\n'); const timer = setInterval(() => socket.write('x-trickle: 1\r\n'), 50); socket.on('close', () => clearInterval(timer)); }));
  assert.deepEqual(await checkGateway(input(), { port, timeoutMs: 300 }), timeout);
});

test('connection closed before a response is transport-unavailable', async t => {
  const closing = await listen(t, net.createServer(socket => socket.destroy()));
  assert.deepEqual(await checkGateway(input(), { port: closing }), unavailable);
  const f = await app(t, request => request.socket.destroy());
  assert.deepEqual(await checkGateway(input(), { port: f.port }), unavailable);
});

test('refuses invalid paths and inputs before any connection', async t => {
  let connections = 0;
  const port = await listen(t, net.createServer(socket => { connections++; socket.destroy(); }));
  for (const path of ['health', '//x', '/a//b', '/x?q=1', '/x#f', '/a\\b', '/a b', '/a\u0000', '/%', '/%zz', '/%2', '/%E0%A4%A',
    '/__fogd', '/__fogd/x', '/__FOGD', '/__void', '/.well-known/celld', '/.well-known/fogd/x', '/%5f_fogd', '/%255f_fogd', '/%2e%2e/x',
    '/x/../__fogd', '/./__fogd', '/x/%2e%2e/__fogd', '/__fogd;x', '/a%2f%2fb', '/a%5cb', '/a%3fb', '/a%00', '/%25zz', `/${'a'.repeat(512)}`, 7]) {
    assert.throws(() => validateCheckPath(path), /^Error: Check path must be/, String(path));
    await assert.rejects(checkGateway(input({ path }), { port }), /Check path/);
  }
  for (const value of [input({ address: 'localhost' }), input({ host: 'App.test' }), input({ host: 'app' }), input({ tls: 'yes' }), input({ ca: 'x' }),
    { ...input(), port: 1 }, { ...input(), headers: {} }, null, []]) await assert.rejects(checkGateway(value, { port }), /Check input is invalid/);
  for (const path of ['/', '/health', '/a/b-c_d.e~f', '/__fogdx', '/.well-known/acme', '/caf%C3%A9', '/x%20y']) assert.equal(validateCheckPath(path), path);
  assert.equal(connections, 0);
});

test('TLS validates normally: untrusted refused, provided CA with matching host succeeds, mismatched host fails', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-check-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=app-a.test', '-addext', 'subjectAltName=DNS:app-a.test']);
  const tls = { key: await readFile(key, 'utf8'), cert: await readFile(cert, 'utf8') }, hosts = [];
  const port = await listen(t, https.createServer(tls, (request, response) => { hosts.push(request.headers.host); response.writeHead(204); response.end(); }));
  assert.deepEqual(await checkGateway(input({ tls: true }), { port }), unavailable);
  assertOk(await checkGateway(input({ tls: true, ca: tls.cert }), { port }), 204);
  assert.deepEqual(await checkGateway(input({ tls: true, ca: tls.cert, host: 'app-b.test' }), { port }), unavailable);
  assert.deepEqual(hosts, ['app-a.test']);
});

test('main refuses oversized or invalid stdin without printing anything', async () => {
  for (const text of ['x'.repeat(131073), JSON.stringify(input({ path: '/__fogd/state' }))]) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { main } from ${JSON.stringify(worker)}; await main();`]);
    child.stdin.on('error', () => {}); child.stdin.end(text);
    let out = ''; child.stdout.on('data', part => { out += part; }); child.stderr.resume();
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0); assert.equal(out, '');
  }
});

test('an unsolicited protocol upgrade is closed without handing back a socket', async t => {
  const port = await listen(t, net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: other\r\n\r\n'));
  }));
  assert.deepEqual(await checkGateway(input(), { port }), unavailable);
});
