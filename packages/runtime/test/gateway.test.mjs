import test from 'node:test';
import assert from 'node:assert/strict';
import gateway from '../src/gateway.js';

test('controller routing serves only the selected app fleet with authenticated host lookup', async () => {
  const controller = { async fetch(input, options) {
    const url = new URL(input);
    assert.equal(url.pathname, '/internal/route');
    assert.equal(url.searchParams.get('host'), 'notebook.localhost');
    assert.equal(options.headers.Authorization, 'Bearer gateway-credential');
    return Response.json({ state: 'active', slot: 'slot-2' });
  } };
  const wrongFleet = { fetch() { throw new Error('Wrong application fleet'); } };
  const selectedFleet = { async fetch(input) {
    if (typeof input === 'string') return new Response('{}');
    assert.equal(new URL(input.url).pathname, '/entries');
    return new Response('notebook records');
  } };
  const response = await gateway.fetch(new Request('https://notebook.localhost:8787/entries'), {
    CONTROLLER: controller, GATEWAY_TOKEN: 'gateway-credential',
    'slot-1-0': wrongFleet, 'slot-1-1': wrongFleet, 'slot-2-0': selectedFleet, 'slot-2-1': selectedFleet,
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'notebook records');
});

test('controller routing refuses unknown, paused and unconfigured app destinations', async () => {
  for (const [target, status, text] of [
    [{ state: 'unknown' }, 404, 'Unknown app'],
    [{ state: 'paused', slot: 'slot-1' }, 503, 'App activation paused'],
    [{ state: 'retired', slot: 'slot-1' }, 503, 'App activation paused'],
    [{ state: 'active', slot: 'missing' }, 503, 'Routing unavailable'],
  ]) {
    const backend = { fetch() { return new Response('must not serve this app'); } };
    const response = await gateway.fetch(new Request('http://hello.localhost/'), {
      CONTROLLER: { async fetch() { return Response.json(target); } }, GATEWAY_TOKEN: 'gateway-credential',
      'slot-1-0': backend, 'slot-1-1': backend, NODE_A: backend, NODE_B: backend,
    });
    assert.equal(response.status, status, JSON.stringify(target));
    assert.equal(await response.text(), text, JSON.stringify(target));
  }
});

test('controller lookup failure refuses serving instead of using the legacy fallback', async () => {
  for (const controller of [
    { async fetch() { throw new Error('Controller unavailable'); } },
    { async fetch() { return new Response('Denied', { status: 401 }); } },
    { async fetch() { return new Response('invalid route JSON'); } },
  ]) {
    const backend = { fetch() { return new Response('must not use legacy fallback'); } };
    const response = await gateway.fetch(new Request('http://hello.localhost/'), {
      CONTROLLER: controller, APP_HOST: 'hello.localhost', NODE_A: backend, NODE_B: backend,
    });
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'Routing unavailable');
  }
});

test('controller-selected fleet never replays a sent mutation after a lost reply', async () => {
  let attempts = 0;
  const backend = { async fetch(input) {
    if (typeof input === 'string') return new Response('{}');
    attempts++; throw new Error('Reply lost after committing');
  } };
  const response = await gateway.fetch(new Request('http://hello.localhost/write', { method: 'POST', body: 'write' }), {
    CONTROLLER: { async fetch() { return Response.json({ state: 'active', slot: 'slot-1' }); } },
    'slot-1-0': backend, 'slot-1-1': backend,
  });
  assert.equal(response.status, 502);
  assert.equal(await response.text(), 'Backend unavailable; outcome may be unknown');
  assert.equal(attempts, 1);
});

test('gateway blocks internal paths including encoded paths before forwarding', async () => {
  let calls = 0;
  const backend = { fetch() { calls++; return new Response('unexpected'); } };
  for (const path of ['/__fogd/export', '/%5f%5ffogd/export', '/__fogd%2fimport', '/__void/migrate', '/%5f%5fvoid/migrate', '/__void%2fmigrate', '/__void/scheduled', '/%5f%5fvoid/scheduled', '/__void%2fscheduled', '/.well-known/celld/health', '/%2ewell-known/celld/health']) {
    const result = await gateway.fetch(new Request('http://hello.localhost' + path), { APP_HOST: 'hello.localhost', NODE_A: backend, NODE_B: backend });
    assert.equal(result.status, 404, path);
  }
  assert.equal(calls, 0);
});

test('gateway never retries a sent mutation and strips privileged headers', async () => {
  let attempts = 0;
  const backend = { async fetch(input) {
    if (typeof input === 'string') return new Response('{}');
    assert.equal(input.headers.has('x-void-secret'), false);
    assert.equal(input.headers.has('x-fogd-token'), false);
    assert.equal(input.headers.has('x-fogd-maintenance'), false);
    assert.equal(input.headers.has('cf-access-authenticated-user-email'), false);
    attempts++; throw Error('Response lost after committing');
  } };
  const result = await gateway.fetch(new Request('http://hello.localhost/write', { method: 'POST', body: 'write', headers: { 'x-void-secret': 'x', 'x-fogd-token': 'x', 'x-fogd-maintenance': '1', 'cf-access-authenticated-user-email': 'x' } }), { APP_HOST: 'hello.localhost', NODE_A: backend, NODE_B: backend });
  assert.equal(result.status, 502); assert.equal(attempts, 1);
});

test('gateway replaces forwarding claims with its actual origin in both profiles', async () => {
  for (const protocol of ['http', 'https']) {
    const backend = { async fetch(input) {
      if (typeof input === 'string') return new Response('{}');
      assert.equal(input.headers.get('x-forwarded-proto'), protocol);
      assert.equal(input.headers.get('x-forwarded-host'), 'hello.localhost:8787');
      assert.equal(input.headers.has('x-forwarded-for'), false);
      assert.equal(input.headers.has('forwarded'), false);
      return new Response('correct origin');
    } };
    const request = new Request(`${protocol}://hello.localhost:8787/`, { headers: { 'x-forwarded-proto': protocol === 'http' ? 'https' : 'http', 'x-forwarded-host': 'evil.example', 'x-forwarded-for': 'spoof', forwarded: 'host=evil.example;proto=http' } });
    assert.equal((await gateway.fetch(request, { APP_HOST: 'hello.localhost', NODE_A: backend, NODE_B: backend })).status, 200);
  }
});
