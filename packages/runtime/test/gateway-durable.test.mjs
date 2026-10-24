import test from 'node:test';
import assert from 'node:assert/strict';
import gateway from '../src/gateway-durable.js';

const policy = { installation: 'a'.repeat(64), slots: ['slot-1', 'slot-2'] };
const id = '00000000-0000-4000-8000-000000000001', digest = 'b'.repeat(64);
const active = (revision = '1') => ({ schema: 1, installation: policy.installation, revision, routes: [{ host: 'alpha.localhost', state: 'active', slot: 'slot-1', submission: id, digest }] });
function fixture() {
  let value = JSON.stringify(active()), reads = 0, requests = 0;
  const backend = { async fetch(input) { if (typeof input === 'string') return new Response('{}'); requests++; return new Response('alpha records'); } };
  const wrong = { async fetch() { throw new Error('Wrong app fleet'); } };
  const env = { ROUTE_POLICY: JSON.stringify(policy), ROUTE_AUTHORITY: { async fetch(url, options) {
    assert.equal(url, 'http://authority/routes.json'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['Cache-Control'], 'no-store'); assert.ok(options.signal instanceof AbortSignal);
    reads++; return new Response(value);
  } }, 'slot-1-0': backend, 'slot-1-1': backend, 'slot-2-0': wrong, 'slot-2-1': wrong };
  Object.defineProperty(env, 'CONTROLLER', { get() { throw new Error('Controller must not be consulted'); } });
  return { env, backend, set: next => { value = typeof next === 'string' ? next : JSON.stringify(next); }, reads: () => reads, requests: () => requests };
}
test('durable gateway serves the approved fleet without any controller dependency', async () => {
  const f = fixture(), response = await gateway.fetch(new Request('https://alpha.localhost:8787/entries'), f.env);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'alpha records');
  assert.equal(f.reads(), 1); assert.equal(f.requests(), 1);
});
test('every new request observes replacement and withholding instead of cached permission', async () => {
  const f = fixture(); await (await gateway.fetch(new Request('http://alpha.localhost/'), f.env)).body.cancel();
  f.set({ ...active('2'), routes: [{ host: 'alpha.localhost', state: 'withheld', slot: 'slot-1' }] });
  const paused = await gateway.fetch(new Request('http://alpha.localhost/'), f.env);
  assert.equal(paused.status, 503); assert.equal(await paused.text(), 'App activation paused');
  f.set(active('3')); const resumed = await gateway.fetch(new Request('http://alpha.localhost/'), f.env);
  assert.equal(resumed.status, 200); await resumed.body.cancel(); assert.equal(f.reads(), 3); assert.equal(f.requests(), 2);
});
for (const [name, value] of [
  ['invalid JSON', 'private-do-not-echo'], ['foreign installation', { ...active(), installation: 'c'.repeat(64) }],
  ['unknown slot', { ...active(), routes: [{ ...active().routes[0], slot: 'foreign' }] }],
  ['duplicate host', { ...active(), routes: [active().routes[0], { host: 'alpha.localhost', state: 'withheld', slot: 'slot-2' }] }],
  ['oversized valid JSON', JSON.stringify(active()).padEnd(65537, ' ')],
]) test(`invalid authority refuses the whole table: ${name}`, async () => {
  const f = fixture(); f.set(value); const response = await gateway.fetch(new Request('http://alpha.localhost/'), f.env);
  assert.equal(response.status, 503); assert.equal(await response.text(), 'Routing unavailable'); assert.equal(f.requests(), 0);
});
test('empty authority reports unknown hosts without using legacy bindings', async () => {
  const f = fixture(); f.set({ schema: 1, installation: policy.installation, revision: '0', routes: [] });
  f.env.APP_HOST = 'alpha.localhost'; f.env.NODE_A = f.backend; f.env.NODE_B = f.backend;
  const response = await gateway.fetch(new Request('http://alpha.localhost/'), f.env);
  assert.equal(response.status, 404); assert.equal(await response.text(), 'Unknown app'); assert.equal(f.requests(), 0);
});
for (const status of [301, 302, 303, 307, 308, 404, 304, 206, 500]) test(`authority HTTP ${status} never enables routing or a legacy fallback`, async () => {
  const f = fixture(); f.env.ROUTE_AUTHORITY = { async fetch() { return new Response(status === 304 ? null : JSON.stringify(active()), { status }); } };
  const response = await gateway.fetch(new Request('http://alpha.localhost/'), f.env);
  assert.equal(response.status, 503); assert.equal(await response.text(), 'Routing unavailable'); assert.equal(f.requests(), 0);
});
test('authority read failure after a successful request cannot reuse the prior decision', async () => {
  const f = fixture(); await (await gateway.fetch(new Request('http://alpha.localhost/'), f.env)).body.cancel();
  f.env.ROUTE_AUTHORITY = { async fetch() { throw new Error('private-do-not-echo'); } };
  const response = await gateway.fetch(new Request('http://alpha.localhost/'), f.env);
  assert.equal(response.status, 503); assert.equal(await response.text(), 'Routing unavailable'); assert.equal(f.requests(), 1);
});
test('authority body enforces UTF-8 and cannot pass invalid bytes to a permissive decoder', async () => {
  const f = fixture(); f.env.ROUTE_AUTHORITY = { async fetch() { return new Response(new Uint8Array([0xff])); } };
  const response = await gateway.fetch(new Request('http://alpha.localhost/'), f.env);
  assert.equal(response.status, 503); assert.equal(await response.text(), 'Routing unavailable'); assert.equal(f.requests(), 0);
});
test('an earlier read may finish after pause while every later request sees withholding', async () => {
  const f = fixture(); let release, started;
  const held = new Promise(resolve => { release = resolve; }), reading = new Promise(resolve => { started = resolve; });
  const earlier = JSON.stringify(active());
  f.env.ROUTE_AUTHORITY = { async fetch() { started(); return new Response(new ReadableStream({ async start(controller) { await held; controller.enqueue(new TextEncoder().encode(earlier)); controller.close(); } })); } };
  const beforePause = gateway.fetch(new Request('http://alpha.localhost/'), f.env); await reading;
  f.env.ROUTE_AUTHORITY = { async fetch() { return Response.json({ ...active('2'), routes: [{ host: 'alpha.localhost', state: 'withheld', slot: 'slot-1' }] }); } };
  const afterPause = await gateway.fetch(new Request('http://alpha.localhost/'), f.env); assert.equal(afterPause.status, 503); await afterPause.body.cancel();
  release(); const earlierResponse = await beforePause; assert.equal(earlierResponse.status, 200); await earlierResponse.body.cancel();
  assert.equal(f.requests(), 1);
});

test('oversized streaming authority is cancelled before the producer is drained', async () => {
  const f = fixture(); let pulls = 0, cancelled = false;
  f.env.ROUTE_AUTHORITY = { async fetch() { return new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(65536)); if (pulls === 5) controller.close(); },
    cancel() { cancelled = true; },
  })); } };
  const response = await gateway.fetch(new Request('http://alpha.localhost/'), f.env);
  assert.equal(response.status, 503); assert.equal(await response.text(), 'Routing unavailable');
  assert.equal(cancelled, true); assert.ok(pulls <= 3); assert.equal(f.requests(), 0);
});
test('a stalled authority body expires and is cancelled without routing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let started, cancelled = false;
  const reading = new Promise(resolve => { started = resolve; });
  f.env.ROUTE_AUTHORITY = { async fetch() { return new Response(new ReadableStream({ start() { started(); }, cancel() { cancelled = true; } })); } };
  const response = gateway.fetch(new Request('http://alpha.localhost/'), f.env); await reading;
  t.mock.timers.tick(3000); const result = await response;
  assert.equal(result.status, 503); assert.equal(await result.text(), 'Routing unavailable'); assert.equal(cancelled, true); assert.equal(f.requests(), 0);
});
test('a stalled authority fetch expires without selecting a destination', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let signal;
  f.env.ROUTE_AUTHORITY = { fetch(_url, options) { signal = options.signal; return new Promise(() => {}); } };
  const response = gateway.fetch(new Request('http://alpha.localhost/'), f.env);
  t.mock.timers.tick(3000); const result = await response;
  assert.equal(result.status, 503); assert.equal(signal.aborted, true); assert.equal(f.requests(), 0);
});
test('missing a selected replica binding refuses instead of sending to a partial or legacy fleet', async () => {
  const f = fixture(); delete f.env['slot-1-1']; f.env.NODE_A = f.backend; f.env.NODE_B = f.backend;
  const response = await gateway.fetch(new Request('http://alpha.localhost/'), f.env);
  assert.equal(response.status, 503); assert.equal(await response.text(), 'Routing unavailable'); assert.equal(f.requests(), 0);
});
test('private paths and spoofed forwarding headers keep the existing protections', async () => {
  const f = fixture();
  const blocked = await gateway.fetch(new Request('https://alpha.localhost/%5f%5fvoid/migrate'), f.env);
  assert.equal(blocked.status, 404); await blocked.body.cancel(); assert.equal(f.requests(), 0);
  const backend = { async fetch(input) {
    if (typeof input === 'string') return new Response('{}');
    assert.equal(input.headers.has('x-void-secret'), false); assert.equal(input.headers.has('x-fogd-token'), false);
    assert.equal(input.headers.has('forwarded'), false); assert.equal(input.headers.has('cf-access-authenticated-user-email'), false);
    assert.equal(input.headers.get('x-forwarded-host'), 'alpha.localhost:8787'); assert.equal(input.headers.get('x-forwarded-proto'), 'https');
    assert.equal(await input.text(), 'write once'); return new Response('accepted');
  } };
  f.env['slot-1-0'] = backend; f.env['slot-1-1'] = backend;
  const response = await gateway.fetch(new Request('https://alpha.localhost:8787/write', { method: 'POST', body: 'write once', headers: {
    'x-void-secret': 'private', 'x-fogd-token': 'private', forwarded: 'host=forged', 'x-forwarded-host': 'forged', 'x-forwarded-proto': 'http', 'cf-access-authenticated-user-email': 'forged',
  } }), f.env);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'accepted');
});
test('a sent write with a lost reply is never retried on the other replica', async () => {
  const f = fixture(); let writes = 0;
  const backend = { async fetch(input) { if (typeof input === 'string') return new Response('{}'); writes++; throw new Error('Reply lost after commit'); } };
  f.env['slot-1-0'] = backend; f.env['slot-1-1'] = backend;
  const response = await gateway.fetch(new Request('http://alpha.localhost/write', { method: 'POST', body: 'change' }), f.env);
  assert.equal(response.status, 502); assert.equal(await response.text(), 'Backend unavailable; outcome may be unknown'); assert.equal(writes, 1);
});

test('gateway health checks fresh authority without implying application readiness', async () => {
  const f = fixture(); f.set({ schema: 1, installation: policy.installation, revision: '0', routes: [] });
  const healthy = await gateway.fetch(new Request('http://gateway/.well-known/fogd/health'), f.env);
  assert.equal(healthy.status, 200); assert.deepEqual(await healthy.json(), { ok: true });
  f.set('broken authority');
  const unavailable = await gateway.fetch(new Request('http://gateway/.well-known/fogd/health'), f.env);
  assert.equal(unavailable.status, 503); assert.equal(await unavailable.text(), 'Routing unavailable');
  assert.equal(f.reads(), 2); assert.equal(f.requests(), 0);
});
test('an invalid installed policy refuses before reading public authority', async () => {
  const f = fixture(); f.env.ROUTE_POLICY = JSON.stringify({ ...policy, privateToken: 'must-not-be-published' });
  const response = await gateway.fetch(new Request('http://alpha.localhost/'), f.env);
  assert.equal(response.status, 503); assert.equal(await response.text(), 'Routing unavailable');
  assert.equal(f.reads(), 0); assert.equal(f.requests(), 0);
});
test('a producer whose cancellation never settles cannot extend the authority deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let started, cancelled = false;
  const reading = new Promise(resolve => { started = resolve; });
  f.env.ROUTE_AUTHORITY = { async fetch() { return new Response(new ReadableStream({
    start() { started(); }, cancel() { cancelled = true; return new Promise(() => {}); },
  })); } };
  const response = gateway.fetch(new Request('http://alpha.localhost/'), f.env); await reading;
  t.mock.timers.tick(3000); const result = await response;
  assert.equal(result.status, 503); assert.equal(cancelled, true); assert.equal(f.requests(), 0);
});

test('request host normalization preserves route selection with mixed case and a port', async () => {
  const f = fixture(), response = await gateway.fetch(new Request('https://ALPHA.localhost:8787/'), f.env);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'alpha records'); assert.equal(f.requests(), 1);
});
test('concurrent authority reads have independent deadlines and decisions', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let reads = 0;
  f.env.ROUTE_AUTHORITY = { fetch() { return ++reads === 1 ? new Promise(() => {}) : Promise.resolve(Response.json(active())); } };
  const stalled = gateway.fetch(new Request('http://alpha.localhost/'), f.env);
  const healthy = await gateway.fetch(new Request('http://alpha.localhost/'), f.env);
  assert.equal(healthy.status, 200); assert.equal(await healthy.text(), 'alpha records');
  t.mock.timers.tick(3000); assert.equal((await stalled).status, 503); assert.equal(f.requests(), 1);
});

test('two active apps reach only their own fleet through the same gateway', async () => {
  const f = fixture(), seen = [];
  f.set({ ...active(), routes: [...active().routes, { ...active().routes[0], host: 'beta.localhost', slot: 'slot-2' }] });
  for (const [slot, app] of [['slot-1', 'alpha'], ['slot-2', 'beta']]) {
    const backend = { async fetch(input) {
      if (typeof input === 'string') return new Response('{}');
      seen.push([app, new URL(input.url).hostname]); return new Response(`${app} records`);
    } };
    f.env[`${slot}-0`] = backend; f.env[`${slot}-1`] = backend;
  }
  for (const app of ['beta', 'alpha', 'beta', 'alpha']) {
    const response = await gateway.fetch(new Request(`http://${app}.localhost/entries`), f.env);
    assert.equal(response.status, 200); assert.equal(await response.text(), `${app} records`);
  }
  assert.deepEqual(seen, [['beta', 'beta.localhost'], ['alpha', 'alpha.localhost'], ['beta', 'beta.localhost'], ['alpha', 'alpha.localhost']]);
});
test('replica health selection uses the healthy peer before sending the app request', async () => {
  const f = fixture(); let probes = 0, unhealthyWrites = 0, healthyWrites = 0;
  f.env['slot-1-0'] = { async fetch(input) {
    if (typeof input === 'string') { probes++; return new Response('unhealthy', { status: 503 }); }
    unhealthyWrites++; return new Response('wrong replica');
  } };
  f.env['slot-1-1'] = { async fetch(input) {
    if (typeof input === 'string') return new Response('{}');
    healthyWrites++; return new Response('healthy replica');
  } };
  // Both alternating start positions must select only the healthy member.
  for (let i = 0; i < 2; i++) {
    const response = await gateway.fetch(new Request('http://alpha.localhost/write', { method: 'POST', body: 'once' }), f.env);
    assert.equal(response.status, 200); assert.equal(await response.text(), 'healthy replica');
  }
  assert.equal(probes, 1); assert.equal(unhealthyWrites, 0); assert.equal(healthyWrites, 2);
});
test('no healthy replicas refuses before sending any app request', async () => {
  const f = fixture(); let probes = 0, requests = 0;
  const unhealthy = { async fetch(input) {
    if (typeof input === 'string') { probes++; return new Response('unhealthy', { status: 503 }); }
    requests++; return new Response('unexpected');
  } };
  f.env['slot-1-0'] = unhealthy; f.env['slot-1-1'] = unhealthy;
  const response = await gateway.fetch(new Request('http://alpha.localhost/write', { method: 'POST', body: 'once' }), f.env);
  assert.equal(response.status, 503); assert.equal(await response.text(), 'No healthy replicas');
  assert.equal(probes, 2); assert.equal(requests, 0);
});
