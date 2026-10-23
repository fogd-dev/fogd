import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { server } from '../src/http.mjs';
import { fixture } from './fixtures/queue-controller.mjs';
import { backgroundBackupApps } from '../../cli/src/recovery/background-backup.mjs';

const authorization = 'Basic ' + Buffer.from('admin:owner-password').toString('base64');
async function serve(t, c) {
  const http = server(c, { user: 'admin', password: 'owner-password', deploy: 'team', gateway: 'gateway' });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  return async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${http.address().port}${path}`, { ...options, headers: { authorization, ...options.headers } });
    return { status: response.status, body: await response.json() };
  };
}
async function setup(t) {
  const f = await fixture(t), rejected = await f.request(); await f.c.mutate(rejected.id, rejected.digest, 'reject');
  const pinned = await f.request(); await f.c.mutate(pinned.id, pinned.digest, 'reject'); await f.c.setArtifactPin(pinned.id, pinned.digest, true);
  const active = await f.request(); await f.c.mutate(active.id, active.digest, 'approve');
  return { ...f, rejected, pinned, active };
}
const post = (csrf, input) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fogd-CSRF': csrf }, body: JSON.stringify(input) });

test('owner pruning reclaims only reviewed terminal bytes and keeps history and protected data', async t => {
  const f = await setup(t), request = await serve(t, f.c), csrf = (await request('/v1/admin')).body.csrf;
  const before = await readFile(join(f.c.artifact(f.pinned.id), 'worker/index.js')), events = [...f.events];
  const plan = (await request('/v1/admin/artifacts')).body;
  const response = await request('/v1/admin/artifacts/prune', post(csrf, { plan: plan.plan }));
  assert.equal(response.status, 200); assert.equal(response.body.reclaimedArtifactBytes, plan.reclaimableArtifactBytes);
  assert.deepEqual(response.body.artifacts.map(row => row.id), [f.rejected.id]);
  await assert.rejects(access(f.c.artifact(f.rejected.id)), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(f.c.artifact(f.pinned.id), 'worker/index.js')), before);
  assert.equal(f.c.state.deployments[f.rejected.id].status, 'rejected');
  assert.equal((await request(`/v1/deployments/${f.rejected.id}/artifact`)).status, 410);
  assert.equal((await request(`/v1/deployments/${f.active.id}/artifact`)).status, 200);
  assert.equal((await request('/v1/admin/artifacts/prune')).body.last.id, response.body.id);
  assert.deepEqual(await request(`/v1/admin/artifacts/prune/${response.body.id}/resume`, post(csrf, {})), response);
  assert.deepEqual(f.events, events); assert.equal(f.c.route('imports.localhost').state, 'active');
});

test('owner auth, CSRF and strict plan payloads precede pruning', async t => {
  const f = await setup(t), request = await serve(t, f.c), csrf = (await request('/v1/admin')).body.csrf;
  const plan = (await request('/v1/admin/artifacts')).body, before = await readFile(join(f.c.dir, 'state.json'));
  for (const [headers, status] of [[{ authorization: 'Bearer team' }, 401], [{ 'X-Fogd-CSRF': '' }, 403], [{ Origin: 'https://other.example' }, 403]]) {
    const options = post(csrf, { plan: plan.plan }); options.headers = { ...options.headers, ...headers };
    assert.equal((await request('/v1/admin/artifacts/prune', options)).status, status);
  }
  assert.equal((await request('/v1/admin/artifacts/prune', post(csrf, { plan: plan.plan, force: true }))).status, 400);
  assert.deepEqual(await readFile(join(f.c.dir, 'state.json')), before);
  assert.equal((await request('/v1/admin/artifacts')).body.plan, plan.plan);
});

test('pending pruning remains inspectable and resumable while mutations and snapshots stay blocked', async t => {
  const f = await setup(t);
  const { planArtifactRetention } = await import('../src/artifact-retention.mjs');
  const plan = await planArtifactRetention(f.c.state, join(f.c.dir, 'artifacts'));
  f.failWrite(value => value.artifactPruning?.operation ? 'after' : null);
  await assert.rejects(f.c.pruneArtifacts(plan.plan), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
  f.failWrite(null); const c = f.create(); await c.init();
  const request = await serve(t, c), admin = await request('/v1/admin'), csrf = admin.body.csrf;
  assert.doesNotMatch(JSON.stringify(admin.body.artifactPruning), /sha256|directories|files|worker\//);
  const status = await request('/v1/admin/artifacts/prune');
  assert.equal(status.status, 200); assert.ok(status.body.operation.id);
  assert.throws(() => backgroundBackupApps(c.state), { code: 'ARTIFACT_PRUNE_PENDING' });
  assert.equal((await request('/v1/admin/artifacts')).status, 503);
  assert.equal((await request(`/v1/deployments/${f.active.id}/artifact`)).status, 503);
  assert.equal((await request(`/v1/admin/artifacts/${f.active.id}/keep`, post(csrf, { digest: f.active.digest }))).status, 503);
  assert.equal(c.route('imports.localhost').state, 'active');
  const path = join(c.artifact(f.rejected.id), 'worker/index.js'), original = await readFile(path);
  await writeFile(path, 'unexpected changed contents');
  assert.equal((await request(`/v1/admin/artifacts/prune/${status.body.operation.id}/resume`, post(csrf, {}))).status, 503);
  assert.equal((await request('/v1/admin/artifacts/prune')).body.operation.id, status.body.operation.id);
  assert.equal(await readFile(path, 'utf8'), 'unexpected changed contents');
  await writeFile(path, original);
  const resumed = await request(`/v1/admin/artifacts/prune/${status.body.operation.id}/resume`, post(csrf, {}));
  assert.equal(resumed.status, 200); assert.equal(resumed.body.reclaimedArtifactBytes, plan.reclaimableArtifactBytes);
  assert.equal((await request('/v1/admin/artifacts')).status, 200);
});
