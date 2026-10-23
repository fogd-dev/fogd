import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { artifactDigest } from '@fogd/runtime/artifact';
import { server } from '../src/http.mjs';
import { fixture } from './fixtures/queue-controller.mjs';

const authorization = 'Basic ' + Buffer.from('admin:owner-password').toString('base64');
async function setup(t) {
  const f = await fixture(t), release = await f.request();
  await f.c.mutate(release.id, release.digest, 'reject');
  const http = server(f.c, { user: 'admin', password: 'owner-password', deploy: 'team-token', gateway: 'gateway-token' });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const request = async (path, options = {}) => {
    const response = await fetch(`${origin}${path}`, { ...options, headers: { authorization, ...options.headers } });
    return { status: response.status, body: await response.json() };
  };
  const csrf = (await request('/v1/admin')).body.csrf;
  const pin = (action, digest = release.digest, headers = {}) => request(`/v1/admin/artifacts/${release.id}/${action}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fogd-CSRF': csrf, ...headers }, body: JSON.stringify({ digest }) });
  return { ...f, release, request, pin, csrf, origin };
}

test('the owner changes retention intent without changing approval, artifacts, quota or backend state', async t => {
  const f = await setup(t), before = JSON.stringify(f.c.state), quota = f.c.quota.describe(), events = [...f.events];
  const kept = await f.pin('keep');
  assert.deepEqual(kept, { status: 200, body: { schema: 1, id: f.release.id, digest: f.release.digest, kept: true } });
  const plan = (await f.request('/v1/admin/artifacts')).body;
  assert.deepEqual(plan.candidates, []); assert.deepEqual(plan.protected[0].reasons, ['operator-pin']);
  assert.deepEqual(await f.pin('unkeep'), { status: 200, body: { schema: 1, id: f.release.id, digest: f.release.digest, kept: false } });
  assert.equal((await f.request('/v1/admin/artifacts')).body.candidates[0].id, f.release.id);
  const { artifactPins, ...state } = f.c.state;
  assert.equal(JSON.stringify(state), before); assert.deepEqual(artifactPins, { schema: 1, releases: {} });
  assert.equal(await artifactDigest(f.c.artifact(f.release.id)), f.release.digest);
  assert.deepEqual(f.c.quota.describe(), quota); assert.deepEqual(f.events, events);
});

test('pin changes require owner authorization, CSRF and a matching origin', async t => {
  const f = await setup(t), token = await f.c.issueCredential('submitter', ['imports']);
  const before = await readFile(join(f.c.dir, 'state.json'));
  for (const [headers, status] of [[{ authorization: 'Bearer team-token' }, 401], [{ authorization: `Bearer ${token.token}` }, 401],
    [{ authorization: '' }, 401], [{ 'X-Fogd-CSRF': '' }, 403], [{ Origin: 'https://other.example' }, 403]]) {
    assert.equal((await f.pin('keep', f.release.digest, headers)).status, status);
  }
  assert.deepEqual(await readFile(join(f.c.dir, 'state.json')), before);
  assert.equal(Object.hasOwn(f.c.state, 'artifactPins'), false);
});

test('wrong identities and extra mutation fields refuse before changing stored pins', async t => {
  const f = await setup(t), before = await readFile(join(f.c.dir, 'state.json'));
  assert.equal((await f.pin('keep', '0'.repeat(64))).status, 400);
  const response = await f.request(`/v1/admin/artifacts/${f.release.id}/keep`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Fogd-CSRF': f.csrf }, body: JSON.stringify({ digest: f.release.digest, force: true }) });
  assert.equal(response.status, 400);
  assert.deepEqual(await readFile(join(f.c.dir, 'state.json')), before);
  assert.equal(Object.hasOwn(f.c.state, 'artifactPins'), false);
});

test('the real CLI keeps, inspects and unkeeps a release through the source API', async t => {
  const f = await setup(t), events = [...f.events];
  const cli = fileURLToPath(new URL('../../cli/bin/fogd.js', import.meta.url));
  const invoke = args => promisify(execFile)(process.execPath, [cli, 'admin', 'artifacts', ...args], { timeout: 20000,
    env: { PATH: process.env.PATH, FOGD_HOME: f.c.dir, FOGD_ENV_FILE: join(f.c.dir, 'operator.env'), FOGD_SERVER: f.origin, FOGD_ADMIN_PASSWORD: 'owner-password' } });
  assert.equal(JSON.parse((await invoke(['keep', f.release.id, f.release.digest])).stdout).kept, true);
  const plan = JSON.parse((await invoke(['plan'])).stdout);
  assert.deepEqual(plan.candidates, []); assert.deepEqual(plan.protected[0].reasons, ['operator-pin']);
  assert.equal(JSON.parse((await invoke(['unkeep', f.release.id, f.release.digest])).stdout).kept, false);
  assert.equal((await f.request('/v1/admin/artifacts')).body.candidates[0].id, f.release.id);
  assert.equal(await artifactDigest(f.c.artifact(f.release.id)), f.release.digest);
  assert.deepEqual(f.events, events);
});
