import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { regularFiles } from '@fogd/runtime/artifact';
import { server } from '../src/http.mjs';
import { fixture } from './fixtures/queue-controller.mjs';

const authorization = 'Basic ' + Buffer.from('admin:owner-password').toString('base64');

async function serve(t, controller, role = 'public') {
  const http = server(controller, { user: 'admin', password: 'owner-password', deploy: 'team-token', gateway: 'gateway-token' }, { role });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const request = async (options = {}, path = '/v1/admin/artifacts') => {
    const response = await fetch(`${origin}${path}`, options);
    return { status: response.status, body: await response.json() };
  };
  return { request, origin };
}

async function snapshot(f) {
  const root = join(f.c.dir, 'artifacts'), paths = await regularFiles(root);
  return { state: structuredClone(f.c.state), disk: await readFile(join(f.c.dir, 'state.json')), quota: f.c.quota.describe(), events: [...f.events],
    files: await Promise.all(paths.map(async path => [path, await readFile(join(root, path))])) };
}

test('the owner gets a fresh terminal-artifact plan without writes or native effects', async t => {
  const f = await fixture(t), rejected = await f.request();
  await f.c.mutate(rejected.id, rejected.digest, 'reject');
  const active = await f.request(); await f.c.mutate(active.id, active.digest, 'approve');
  rejected.error = 'private-backend-diagnostic'; active.version = 'private-runtime-version';
  await f.c.save();
  const { request } = await serve(t, f.c), before = await snapshot(f);
  const response = await request({ headers: { authorization } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.candidates.map(row => ({ id: row.id, digest: row.digest, status: row.status })), [{ id: rejected.id, digest: rejected.digest, status: 'rejected' }]);
  assert.ok(response.body.protected.some(row => row.id === active.id && row.reasons.includes('active')));
  assert.ok(response.body.reclaimableArtifactBytes > 0);
  assert.equal(response.body.retainedArtifactBytes, before.files.reduce((sum, [, bytes]) => sum + bytes.length, 0));
  assert.doesNotMatch(JSON.stringify(response.body), /private-|worker\/|secretRevision|csrf|resources/);
  assert.deepEqual(await snapshot(f), before);
});

test('artifact planning requires owner authentication and is absent from the internal service', async t => {
  const f = await fixture(t), release = await f.request();
  const scoped = await f.c.issueCredential('submitter', ['imports']);
  const { request } = await serve(t, f.c), { request: internal } = await serve(t, f.c, 'internal');
  for (const headers of [{}, { authorization: 'Bearer team-token' }, { authorization: `Bearer ${scoped.token}` }]) {
    const response = await request({ headers });
    assert.equal(response.status, 401); assert.equal(JSON.stringify(response.body).includes(release.id), false);
  }
  assert.equal((await internal({ headers: { authorization } })).status, 404);
});

test('artifact planning exposes no deletion method or alternate artifact path', async t => {
  const f = await fixture(t), release = await f.request(), { request } = await serve(t, f.c);
  const before = await snapshot(f);
  assert.equal((await request({ method: 'POST', headers: { authorization } })).status, 404);
  assert.equal((await request({ headers: { authorization } }, `/v1/admin/artifacts/${release.id}/prune`)).status, 404);
  assert.deepEqual(await snapshot(f), before);
});

test('the real CLI accepts controller-generated orphan and missing rows', async t => {
  const f = await fixture(t), release = await f.request();
  await f.c.mutate(release.id, release.digest, 'reject');
  const missing = '00000000-0000-4000-8000-000000000099';
  f.c.state.deployments[missing] = { ...release, id: missing }; await f.c.save();
  await mkdir(join(f.c.dir, 'artifacts', 'unknown-copy'));
  await writeFile(join(f.c.dir, 'artifacts', 'unknown-copy', 'notice'), 'unknown');
  const { origin } = await serve(t, f.c), before = await snapshot(f);
  const cli = fileURLToPath(new URL('../../cli/bin/fogd.js', import.meta.url));
  const result = await promisify(execFile)(process.execPath, [cli, 'admin', 'artifacts', 'plan'], { timeout: 20000,
    env: { PATH: process.env.PATH, FOGD_HOME: f.c.dir, FOGD_ENV_FILE: join(f.c.dir, 'operator.env'), FOGD_SERVER: origin, FOGD_ADMIN_PASSWORD: 'owner-password' } });
  const plan = JSON.parse(result.stdout);
  assert.equal(result.stderr, ''); assert.equal(plan.candidates[0].id, release.id);
  assert.deepEqual(plan.protected, [{ id: 'unknown-copy', app: null, digest: null, status: null, bytes: 7, reasons: ['unreferenced'] }]);
  assert.deepEqual(plan.missing, [{ id: missing, app: release.app, digest: release.digest, status: 'rejected', reasons: [] }]);
  assert.deepEqual(await snapshot(f), before);
});
