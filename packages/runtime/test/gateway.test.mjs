import test from 'node:test';
import assert from 'node:assert/strict';
import gateway from '../src/gateway.js';

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
