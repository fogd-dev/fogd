import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { deployCapabilities } from '../src/deploy-capabilities.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function fixture(t, respond) {
  const calls = [];
  const http = createServer((request, response) => { calls.push({ path: request.url, authorization: request.headers.authorization }); respond(request, response); });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  return { origin: `http://127.0.0.1:${http.address().port}`, calls };
}
test('a server capability is bound to the authenticated target app', async t => {
  const f = await fixture(t, (_, response) => response.end(JSON.stringify({ schema: 1, app: 'refresh', cronApps: true, queueApps: false })));
  assert.deepEqual(await deployCapabilities(f.origin, 'scoped-token', 'refresh'), { cronApps: true });
  assert.deepEqual(f.calls, [{ path: '/v1/capabilities?app=refresh', authorization: 'Bearer scoped-token' }]);
});
test('legacy admin fallback authenticates on the existing status route and keeps cron staging closed', async t => {
  const f = await fixture(t, (request, response) => { response.statusCode = request.url.startsWith('/v1/capabilities') ? 401 : 404; response.setHeader('WWW-Authenticate', 'Basic realm="fogd admin", charset="UTF-8"'); response.end('{}'); });
  assert.equal((await deployCapabilities(f.origin, 'legacy-token', 'refresh')).cronApps, false);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.authorization === 'Bearer legacy-token'));
  assert.match(f.calls[1].path, /^\/v1\/deployments\//);
});
test('wrong credentials, server failure and malformed capability declarations never open cron staging', async t => {
  for (const [status, body] of [[401, '{}'], [404, '{}'], [405, '{}'], [503, '{}'], [200, 'private-invalid-json'], [200, ' '.repeat(4097) + '{}'], [200, JSON.stringify({ schema: 1, app: 'other', cronApps: true, queueApps: false })], [200, JSON.stringify({ schema: 1, app: 'refresh', cronApps: 'true', queueApps: false })]]) {
    const f = await fixture(t, (_, response) => { response.statusCode = status; response.end(body); });
    await assert.rejects(deployCapabilities(f.origin, 'invalid-token', 'refresh'), error => /capabilit/.test(error.message) && !error.message.includes('private-invalid-json'));
    assert.equal(f.calls.length, 1);
  }
});

test('legacy compatibility refuses failed credential probes and accepts an existing private deployment', async t => {
  for (const status of [200, 401, 503]) {
    const f = await fixture(t, (request, response) => {
      response.statusCode = request.url.startsWith('/v1/capabilities') ? 401 : status;
      response.setHeader('WWW-Authenticate', 'Basic realm="fogd admin", charset="UTF-8"'); response.end('{}');
    });
    if (status === 200) assert.equal((await deployCapabilities(f.origin, 'legacy-token', 'refresh')).cronApps, false);
    else await assert.rejects(deployCapabilities(f.origin, 'legacy-token', 'refresh'), /credential/);
    assert.equal(f.calls.length, 2);
  }
});

test('a scoped server refusal preserves its useful bounded diagnostic', async t => {
  const f = await fixture(t, (_, response) => { response.statusCode = 400; response.end(JSON.stringify({ error: 'Deployment credential is revoked or outside its app scope' })); });
  await assert.rejects(deployCapabilities(f.origin, 'token', 'refresh'), /outside its app scope/);
});

test('the ordinary deploy command negotiates before loading the project build toolchain', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fogd-deploy-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  // No Vite dependency is available: building first would fail before the server
  // can diagnose this credential's scope.
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'refresh' }));
  const f = await fixture(t, (_, response) => { response.statusCode = 400; response.end(JSON.stringify({ error: 'Deployment credential is revoked or outside its app scope' })); });
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../bin/fogd.js', import.meta.url)), 'deploy'], {
    cwd: root, timeout: 10000, env: { ...process.env, FOGD_HOME: root, FOGD_ENV_FILE: join(root, 'absent.env'), FOGD_SERVER: f.origin, FOGD_DEPLOY_TOKEN: 'scoped-token' },
  }), error => error.code === 1 && /outside its app scope/.test(error.stderr) && !/vite|MODULE_NOT_FOUND/.test(error.stderr));
  assert.equal(f.calls.length, 1);
});
