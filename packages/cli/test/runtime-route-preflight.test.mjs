import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { encodeRouteRecord } from '@fogd/runtime/route-record';
import { requestRoutingPreflight } from '../src/runtime/route-preflight.mjs';

const profile = (overrides = {}) => ({
  schema: 3, routing: 'durable', family: 'celld-native', admission: 'candidate', image: 'sha256:' + 'a'.repeat(64), storageImage: 'sha256:' + 'd'.repeat(64),
  binarySha256: 'b'.repeat(64), supervisorSha256: 'c'.repeat(64), controllerArgs: ['packages/platform/src/main-durable.mjs'],
  bucket: 'fogd', storage: { endpoint: 'http://minio:9000', region: 'us-east-1' },
  fleets: [1, 2].map(n => ({ id: `slot-${n}`, prefix: `fleet-${n}`, nodes: ['a', 'b'].map(x => ({ host: `slot-${n}-${x}`, id: `node-${n}-${x}` })) })),
  ...overrides,
});
const policy = { installation: runtimePolicyIdentity(profile()), slots: ['slot-1', 'slot-2'] };
const record = (installation = policy.installation) => ({ schema: 1, installation, revision: '4', routes: [
  { host: 'alpha.apps.test', state: 'active', slot: 'slot-1', submission: '01234567-89ab-cdef-0123-456789abcdef', digest: 'e'.repeat(64) },
  { host: 'beta.apps.test', state: 'withheld', slot: 'slot-2' },
] });
const sha = value => createHash('sha256').update(encodeRouteRecord(value, policy)).digest('hex');
const report = challenge => ({ schema: 1, challenge, authority: { record: record(), sha256: sha(record()) }, observedActiveHosts: ['alpha.apps.test'] });
const CSRF = 'f'.repeat(64), PASSWORD = 'private-admin-password';
const basic = `Basic ${Buffer.from(`admin:${PASSWORD}`).toString('base64')}`;
const env = origin => ({ FOGD_SERVER: origin, FOGD_ADMIN_PASSWORD: PASSWORD });

async function controller(t, respond = (challenge) => [200, report(challenge)], admin = () => [200, { csrf: CSRF, deployments: { secret: 'private-admin-snapshot' } }]) {
  const seen = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    seen.push({ method: request.method, url: request.url, csrf: request.headers['x-fogd-csrf'], body: text });
    const send = ([status, value, type = 'application/json']) => { response.writeHead(status, { 'Content-Type': type }); response.end(typeof value === 'string' ? value : JSON.stringify(value)); };
    if (request.headers.authorization !== basic) return send([401, { error: 'Admin authentication required' }]);
    if (request.method === 'GET' && request.url === '/v1/admin') return send(admin());
    if (request.method === 'POST' && request.url === '/v1/admin/routing/preflight') {
      if (request.headers['x-fogd-csrf'] !== CSRF) return send([403, { error: 'CSRF token required' }]);
      return send(respond(JSON.parse(text).challenge));
    }
    send([404, { error: 'Not found' }]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}
async function refuses(promise) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'ROUTE_PREFLIGHT_UNCONFIRMED');
    assert.equal(error.message, 'HTTP routing preflight is unconfirmed; keep ingress stopped');
    assert.doesNotMatch(String(error.stack) + JSON.stringify(error), /private|ffffffff|apps\.test/);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('performs CSRF then fresh challenge flow and returns only the validated observation', async t => {
  const { origin, seen } = await controller(t);
  const first = await requestRoutingPreflight(env(origin), profile());
  const second = await requestRoutingPreflight(env(origin), profile());
  assert.match(first.challenge, /^[a-f0-9]{64}$/);
  assert.notEqual(first.challenge, second.challenge);
  assert.deepEqual(first, report(first.challenge));
  assert.deepEqual(seen.slice(0, 2).map(({ method, url, csrf }) => [method, url, csrf]), [['GET', '/v1/admin', undefined], ['POST', '/v1/admin/routing/preflight', CSRF]]);
  assert.deepEqual(JSON.parse(seen[1].body), { challenge: first.challenge });
  assert.doesNotMatch(JSON.stringify(first), /csrf|private/i);
});

test('ignores caller-supplied challenge or report options', async t => {
  const { origin, seen } = await controller(t);
  const result = await requestRoutingPreflight(env(origin), profile(), { challenge: '0'.repeat(64), report: report('0'.repeat(64)) });
  assert.notEqual(result.challenge, '0'.repeat(64));
  assert.equal(JSON.parse(seen[1].body).challenge, result.challenge);
});

test('refuses profiles that are not an independently valid durable schema 3 runtime', async t => {
  const { origin, seen } = await controller(t);
  for (const bad of [profile({ schema: 2, controllerArgs: ['packages/platform/src/main.mjs'], routing: undefined }), profile({ routing: 'legacy' }), profile({ bucket: 'BAD' }), null]) {
    if (bad && bad.routing === undefined) delete bad.routing;
    await assert.rejects(requestRoutingPreflight(env(origin), bad), { code: 'ROUTE_PREFLIGHT_PROFILE' });
  }
  assert.equal(seen.length, 0);
});

test('refuses stale, foreign, invalid and mismatched reports', async t => {
  const mutate = fn => challenge => { const value = report(challenge); fn(value, challenge); return [200, value]; };
  const cases = {
    stale: mutate(value => { value.challenge = '0'.repeat(64); }),
    foreign: mutate(value => { const foreign = record('9'.repeat(64)); value.authority = { record: foreign, sha256: createHash('sha256').update(JSON.stringify(foreign, null, 2)).digest('hex') }; }),
    invalidRecord: mutate(value => { value.authority.record.routes[0].slot = 'slot-9'; }),
    extraRecordKey: mutate(value => { value.authority.record.extra = true; }),
    wrongHash: mutate(value => { value.authority.sha256 = '0'.repeat(64); }),
    compactHash: mutate(value => { value.authority.sha256 = createHash('sha256').update(JSON.stringify(record())).digest('hex'); }),
    missingHost: mutate(value => { value.observedActiveHosts = []; }),
    extraHost: mutate(value => { value.observedActiveHosts.push('beta.apps.test'); }),
    duplicateHost: mutate(value => { value.observedActiveHosts.push('alpha.apps.test'); }),
    extraKey: mutate(value => { value.lease = true; }),
    missingKey: mutate(value => { delete value.observedActiveHosts; }),
    wrongSchema: mutate(value => { value.schema = 2; }),
    authorityShape: mutate(value => { value.authority.extra = 1; }),
    array: () => [200, []],
    refusedStatus: () => [503, { code: 'ROUTE_PREFLIGHT_UNCONFIRMED' }],
    html: challenge => [200, JSON.stringify(report(challenge)), 'text/html; charset=utf-8'],
    malformed: () => [200, '{"schema":1,'],
    oversized: challenge => [200, JSON.stringify({ ...report(challenge), pad: 'x'.repeat(300 * 1024) })],
  };
  for (const [name, respond] of Object.entries(cases)) {
    const { origin } = await controller(t, respond);
    await t.test(name, () => refuses(requestRoutingPreflight(env(origin), profile())));
  }
});

test('refuses invalid UTF-8 bytes rather than replacing them', async t => {
  // A replacing decoder would accept this: the later duplicate key overwrites the bad byte.
  const body = challenge => Buffer.concat([Buffer.from('{"schema":"'), Buffer.from([0xff]), Buffer.from('",' + JSON.stringify(report(challenge)).slice(1))]);
  const lenient = new TextDecoder().decode(body('0'.repeat(64)));
  assert.equal(JSON.parse(lenient).schema, 1);
  await refuses(requestRoutingPreflight(env('http://controller.test'), profile(), { fetchImpl: async (url, init) => url.endsWith('/v1/admin')
    ? Response.json({ csrf: CSRF }) : new Response(body(JSON.parse(init.body).challenge), { headers: { 'Content-Type': 'application/json' } }) }));
});

test('refuses unauthorized, recovery-only and malformed admin sessions', async t => {
  const wrong = await controller(t);
  await refuses(requestRoutingPreflight({ ...env(wrong.origin), FOGD_ADMIN_PASSWORD: 'nope-private' }, profile()));
  await refuses(requestRoutingPreflight({ FOGD_SERVER: wrong.origin }, profile()));
  assert.equal(wrong.seen.filter(value => value.method === 'POST').length, 0);
  for (const admin of [() => [200, { csrf: CSRF, recoveryOnly: true, ingress: 'keep-stopped' }], () => [200, { csrf: 'short' }], () => [200, '<html>private</html>', 'text/html'], () => [302, '']]) {
    const { origin, seen } = await controller(t, undefined, admin);
    await refuses(requestRoutingPreflight(env(origin), profile()));
    assert.equal(seen.filter(value => value.method === 'POST').length, 0);
  }
});

test('never follows redirects', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(init.redirect); return new Response(null, { status: 302, headers: { Location: 'http://elsewhere.test/private' } }); };
  await refuses(requestRoutingPreflight(env('http://controller.test'), profile(), { fetchImpl }));
  assert.deepEqual(calls, ['error']);
});

test('bounds stalled bodies by a finite operation deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let pulled, cancelled = false;
  const started = new Promise(resolve => { pulled = resolve; });
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/v1/admin')) return Response.json({ csrf: CSRF });
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(new ReadableStream({ pull() { pulled(); return new Promise(() => {}); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } });
  };
  const pending = requestRoutingPreflight(env('http://controller.test'), profile(), { fetchImpl });
  await started;
  t.mock.timers.tick(30000);
  await refuses(pending);
  assert.equal(cancelled, true);
});

test('bounds stalled headers by the same deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let called;
  const started = new Promise(resolve => { called = resolve; });
  const fetchImpl = (url, init) => new Promise((resolve, reject) => { called(); init.signal.addEventListener('abort', () => reject(new Error('private abort detail'))); });
  const pending = requestRoutingPreflight(env('http://controller.test'), profile(), { fetchImpl });
  await started;
  t.mock.timers.tick(30000);
  await refuses(pending);
});
