import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { ingressFixture, origin, key, identity } from './fixtures/preview-ingress.mjs';

const form = body => ({ method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body });

test('HTTPS sign-in identifies the exact preview without reaching application code', async t => {
  const f = await ingressFixture(t), before = await f.send('/');
  assert.equal(before.status, 401); assert.equal(before.headers['cache-control'], 'no-store');
  assert.equal(before.headers['referrer-policy'], 'same-origin');
  for (const value of Object.values(identity)) assert.ok(before.body.toString().includes(value));
  assert.ok(before.body.toString().includes('label for="preview-key"')); assert.ok(!before.body.toString().includes(key));
  const cookie = await f.login(), status = await f.send('/.well-known/fogd-preview/status', { headers: { cookie } });
  assert.deepEqual(JSON.parse(status.body), { status: 'active', ...identity, expiresAt: f.config.expiresAt });
  assert.deepEqual(f.calls, []);
});

test('gateway credentials stay out of application headers while app credentials and writes survive', async t => {
  const f = await ingressFixture(t), cookie = await f.login();
  const result = await f.send('/api/save?draft=1', { method: 'POST', headers: { origin, cookie: `${cookie}; app-session=fixture`, authorization: 'Bearer app-only', 'x-forwarded-host': 'production.test', forwarded: 'for=production', 'proxy-authorization': 'private-proxy', 'x-void-user': 'spoofed', 'x-fogd-app': 'production', 'cf-connecting-ip': 'spoofed' }, body: 'saved-once' });
  assert.equal(result.status, 200); assert.equal(f.calls.length, 1);
  assert.deepEqual({ method: f.calls[0].method, path: f.calls[0].path, body: f.calls[0].body }, { method: 'POST', path: '/api/save?draft=1', body: 'saved-once' });
  assert.equal(f.calls[0].headers.cookie, 'app-session=fixture'); assert.equal(f.calls[0].headers.authorization, 'Bearer app-only');
  assert.equal(f.calls[0].headers.host, 'preview.test'); assert.equal(f.calls[0].headers.origin, origin);
  for (const field of ['x-forwarded-host', 'forwarded', 'proxy-authorization', 'x-void-user', 'x-fogd-app', 'cf-connecting-ip']) assert.equal(f.calls[0].headers[field], undefined);
  assert.ok(!JSON.stringify(f.calls).includes(cookie.split('=')[1])); assert.ok(!JSON.stringify(f.calls).includes(key));
});

for (const [label, options] of [
  ['wrong key', form(`key=${'c'.repeat(64)}`)],
  ['duplicate key', form(`key=${key}&key=${key}`)],
  ['cross-origin login', { ...form(`key=${key}`), headers: { origin: 'https://other.test', 'content-type': 'application/x-www-form-urlencoded' } }],
  ['opaque origin', { ...form(`key=${key}`), headers: { origin: 'null', 'content-type': 'application/x-www-form-urlencoded' } }],
  ['missing origin', { ...form(`key=${key}`), headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
]) test(`${label} cannot authenticate or reach the app`, async t => {
  const f = await ingressFixture(t), result = await f.send('/.well-known/fogd-preview/login', options);
  assert.equal(result.status, 403); assert.equal(result.headers['set-cookie'], undefined); assert.deepEqual(f.calls, []);
});

test('wrong host and duplicate gateway cookies refuse before the backend', async t => {
  const f = await ingressFixture(t), cookie = await f.login();
  assert.equal((await f.send('/', { headers: { host: 'production.test', cookie } })).status, 421);
  assert.equal((await f.send('/', { headers: { cookie: `${cookie}; ${cookie}` } })).status, 401);
  assert.deepEqual(f.calls, []);
});

test('cookie grant is scoped to preview identity even when an access key is reused', async t => {
  const first = await ingressFixture(t), cookie = await first.login();
  const second = await ingressFixture(t, { changeConfig: c => { c.identity = { ...identity, preview: '00000000-0000-4000-8000-000000000003' }; } });
  assert.equal((await second.send('/', { headers: { cookie } })).status, 401); assert.deepEqual(second.calls, []);
});

test('browser access cookie has host-only secure attributes and logout removes access', async t => {
  const f = await ingressFixture(t), signed = await f.send('/.well-known/fogd-preview/login', form(`key=${key}`));
  const value = signed.headers['set-cookie'][0];
  for (const field of ['__Host-fogd-preview=', 'Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(value.includes(field));
  assert.ok(!value.includes('Domain=')); assert.ok(!value.includes(key));
  const cookie = value.split(';', 1)[0];
  const result = await f.send('/.well-known/fogd-preview/logout', { ...form(''), headers: { ...form('').headers, cookie } });
  assert.equal(result.status, 303); assert.ok(result.headers['set-cookie'][0].includes('Max-Age=0')); assert.deepEqual(f.calls, []);
});

test('backend cookie, browser policy and redirect headers cannot override the preview boundary', async t => {
  const f = await ingressFixture(t, { respond: (_req, res) => { res.writeHead(200, {
    'set-cookie': ['__Host-fogd-preview=app-forgery; Secure; Path=/', 'app-session=kept; Domain=production.test; Path=/; HttpOnly'],
    'content-security-policy': 'default-src *', 'access-control-allow-origin': '*', 'service-worker-allowed': '/', 'clear-site-data': '"cookies"', 'cache-control': 'public',
  }); res.end('app'); } });
  const result = await f.send('/', { headers: { cookie: await f.login() } });
  assert.deepEqual(result.headers['set-cookie'], ['app-session=kept; Path=/; HttpOnly']);
  assert.ok(result.headers['content-security-policy'].includes("connect-src 'self'")); assert.equal(result.headers['cache-control'], 'no-store');
  for (const field of ['access-control-allow-origin', 'service-worker-allowed', 'clear-site-data']) assert.equal(result.headers[field], undefined);
});

test('external redirects are not followed or passed through', async t => {
  const f = await ingressFixture(t, { respond: (_req, res) => { res.writeHead(302, { location: 'https://production.test/change' }); res.end(); } });
  const result = await f.send('/', { headers: { cookie: await f.login() } });
  assert.equal(result.status, 502); assert.equal(result.headers.location, undefined); assert.equal(f.calls.length, 1);
});

test('upstream response loss after a write is reported without replay', async t => {
  const f = await ingressFixture(t, { respond: (req) => req.socket.destroy() });
  const result = await f.send('/write', { ...form('saved'), headers: { ...form('').headers, cookie: await f.login() } });
  assert.equal(result.status, 502); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body, 'saved');
  assert.ok(result.body.toString().includes('outcome may be unknown'));
});

test('compressed binary responses retain exact bytes and encoding', async t => {
  const bytes = gzipSync(Buffer.from([0, 255, 1, 200]));
  const f = await ingressFixture(t, { respond: (_req, res) => { res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': bytes.length }); res.end(bytes); } });
  const result = await f.send('/', { headers: { cookie: await f.login() } });
  assert.deepEqual(result.body, bytes); assert.equal(result.headers['content-encoding'], 'gzip'); assert.equal(Number(result.headers['content-length']), bytes.length);
});

test('expiry ends pending access and prevents subsequent backend requests', async t => {
  const f = await ingressFixture(t, { lifetime: 1200, respond: () => {} }), cookie = await f.login();
  const pending = f.send('/held', { headers: { cookie } });
  const result = await pending; assert.equal(result.status, 410); assert.equal(f.calls.length, 1);
  assert.equal((await f.send('/', { headers: { cookie } })).status, 410); assert.equal(f.calls.length, 1);
});

test('revoke cancels admitted requests and refuses new calls', async t => {
  const f = await ingressFixture(t, { respond: () => {} }), cookie = await f.login();
  const pending = f.send('/held', { headers: { cookie } });
  for (let i = 0; i < 100 && f.calls.length === 0; i++) await delay(10);
  assert.equal(f.calls.length, 1); f.ingress.revoke();
  assert.equal((await pending).status, 410);
  assert.equal((await f.send('/', { headers: { cookie } })).status, 410); assert.equal(f.calls.length, 1);
});

test('oversized application request refuses before contacting the app', async t => {
  const f = await ingressFixture(t), cookie = await f.login();
  const result = await f.send('/upload', { ...form('x'.repeat(2 * 1024 * 1024 + 1)), headers: { ...form('').headers, cookie } });
  assert.equal(result.status, 413); assert.deepEqual(f.calls, []);
});

test('cross-origin mutations with an otherwise valid cookie refuse before app execution', async t => {
  const f = await ingressFixture(t), cookie = await f.login();
  const result = await f.send('/write', { method: 'POST', headers: { cookie, origin: 'https://production.test' }, body: 'change' });
  assert.equal(result.status, 403); assert.deepEqual(f.calls, []);
});

test('changing caller configuration does not replace a running preview identity or expiry', async t => {
  const f = await ingressFixture(t), cookie = await f.login();
  f.config.identity.app = 'changed'; f.config.expiresAt = '2099-01-01T00:00:00.000Z';
  const result = await f.send('/.well-known/fogd-preview/status', { headers: { cookie } });
  assert.equal(JSON.parse(result.body).app, 'demo'); assert.notEqual(JSON.parse(result.body).expiresAt, f.config.expiresAt);
});

test('wrong backend trust fails before HTTP and withholds TLS diagnostics', async t => {
  const other = await ingressFixture(t);
  const f = await ingressFixture(t, { changeConfig: c => { c.upstreamCA = other.config.tls.cert; } });
  const result = await f.send('/', { headers: { cookie: await f.login() } });
  assert.equal(result.status, 502); assert.deepEqual(f.calls, []);
  assert.ok(!result.body.toString().includes('CERT')); assert.ok(!result.body.toString().includes('BEGIN'));
});

test('a certificate for another public origin refuses before listening', async t => {
  await assert.rejects(ingressFixture(t, { changeConfig: c => { c.origin = 'https://wrong.test'; } }), /certificate must cover/);
});

test('encoded reserved paths cannot reach application handlers', async t => {
  const f = await ingressFixture(t), cookie = await f.login();
  const result = await f.send('/.well-known/%66ogd-preview/status', { headers: { cookie } });
  assert.equal(result.status, 200); assert.equal(JSON.parse(result.body).preview, identity.preview);
  assert.equal((await f.send('/%ZZ', { headers: { cookie } })).status, 400); assert.deepEqual(f.calls, []);
});

test('bounded concurrency refuses a seventeenth request without interrupting admitted calls', async t => {
  const f = await ingressFixture(t, { respond: () => {} }), cookie = await f.login();
  const pending = Array.from({ length: 16 }, () => f.send('/held', { headers: { cookie } }));
  for (let i = 0; i < 200 && f.calls.length !== 16; i++) await delay(10);
  assert.equal(f.calls.length, 16);
  assert.equal((await f.send('/overflow', { headers: { cookie } })).status, 429); assert.equal(f.calls.length, 16);
  f.ingress.revoke(); assert.ok((await Promise.all(pending)).every(r => r.status === 410));
});

test('an unsolicited backend protocol upgrade is refused without hanging the request', async t => {
  const f = await ingressFixture(t, { respond: (_req, res) => { res.writeHead(101, { connection: 'Upgrade', upgrade: 'websocket' }); res.end(); } });
  const result = await f.send('/', { headers: { cookie: await f.login() } });
  assert.equal(result.status, 502); assert.equal(f.calls.length, 1);
});

test('array-valued release identities cannot become preview grants', async t => {
  await assert.rejects(ingressFixture(t, { changeConfig: c => { c.identity = { ...identity, app: ['demo'] }; } }), /exact public release identities/);
});

test('a six-request browser resource burst can finish without capacity refusal', async t => {
  const f = await ingressFixture(t, { respond: (_req, res) => { setTimeout(() => res.end('asset'), 50); } }), cookie = await f.login();
  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => f.send(`/asset-${index}`, { headers: { cookie } })));
  assert.ok(responses.every(response => response.status === 200)); assert.equal(f.calls.length, 6);
});

test('an unresponsive backend reaches the upstream deadline without a retry', { timeout: 15000 }, async t => {
  const f = await ingressFixture(t, { respond: () => {} }), cookie = await f.login();
  const result = await f.send('/never-replies', { headers: { cookie } });
  assert.equal(result.status, 502); assert.equal(f.calls.length, 1);
  assert.ok(result.body.toString().includes('outcome may be unknown'));
});
