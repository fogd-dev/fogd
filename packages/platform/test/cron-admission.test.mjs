import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Controller } from '../src/controller.mjs';
import { server } from '../src/http.mjs';
import { stageArtifact } from '@fogd/runtime/artifact';
import { manifest, receiveArtifact } from '@fogd/runtime/manifest';

async function fixture(t, cronApps) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-cron-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(join(project, 'dist/ssr'), { recursive: true });
  await writeFile(join(project, 'dist/ssr/index.js'), 'export default {scheduled(){}};');
  await writeFile(join(project, 'dist/ssr/wrangler.json'), JSON.stringify({ main: 'index.js', triggers: { crons: ['* * * * *'] }, secrets: { required: ['REFRESH_TOKEN'] } }));
  const outputDir = join(root, 'release');
  await assert.rejects(stageArtifact({ projectDir: project, outputDir, app: 'refresh' }), /selected runtime/);
  await assert.rejects(access(outputDir), { code: 'ENOENT' });
  const release = await stageArtifact({ projectDir: project, outputDir, app: 'refresh', capabilities: { cronApps: true } });
  const body = await manifest(outputDir, release);
  await assert.rejects(receiveArtifact(body, join(root, 'default-receiver')), /selected runtime/);
  let effects = 0;
  const backend = { owner: async () => { effects++; return null; }, crons: Object.fromEntries(['pause', 'resume', 'status'].map(verb => [verb, async () => { effects++; throw new Error('Unexpected runtime effect'); }])) };
  const controller = new Controller({ dir: join(root, 'controller'), slots: [{ id: 'one', prefix: 'one', nodes: ['a', 'b'] }], backend, cronApps });
  await controller.init(); effects = 0;
  const credential = await controller.issueCredential('refresh builder', ['refresh']);
  const foreign = await controller.issueCredential('other builder', ['other']);
  const http = server(controller, { user: 'admin', password: 'synthetic-password', deploy: 'team-token', gateway: 'gateway' });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const get = (token, app = 'refresh') => fetch(`${origin}/v1/capabilities?app=${app}`, { headers: { Authorization: `Bearer ${token}` } });
  const submit = token => fetch(origin + '/v1/deployments', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { root, controller, credential, foreign, body, get, submit, effects: () => effects };
}

test('guarded scheduled upload is app-scoped, canonical and inert until approval', async t => {
  const f = await fixture(t, true);
  assert.equal((await f.get('wrong')).status, 401);
  assert.equal((await f.get(f.foreign.token)).status, 400);
  assert.equal((await (await f.get('team-token')).json()).cronApps, false);
  assert.deepEqual(await (await f.get(f.credential.token)).json(), { schema: 1, app: 'refresh', queueApps: false, cronApps: true });
  const team = await f.submit('team-token'); assert.equal(team.status, 400);
  assert.match((await team.json()).error, /app-scoped deployment credential/);
  assert.equal((await f.submit(f.foreign.token)).status, 400);
  const response = await f.submit(f.credential.token); assert.equal(response.status, 201);
  const request = await response.json();
  assert.equal(request.status, 'pending'); assert.equal(request.submitter, f.credential.id);
  assert.deepEqual(request.resources.crons, ['* * * * *']);
  assert.deepEqual(request.requiredSecrets, ['REFRESH_TOKEN']);
  assert.deepEqual(f.controller.state.apps, Object.assign(Object.create(null), {}));
  assert.equal(f.effects(), 0);
  assert.deepEqual(JSON.parse(await readFile(join(f.controller.dir, 'state.json'))).apps, {});
  assert.deepEqual(await readdir(join(f.controller.dir, 'artifacts')), [request.id]);
  await f.controller.revokeCredential(f.credential.id);
  assert.equal((await f.get(f.credential.token)).status, 401);
});

test('pending and rejected artifacts do not require runtime authority merely to restart or reject', async t => {
  const f = await fixture(t, true), response = await f.submit(f.credential.token), request = await response.json();
  assert.equal(response.status, 201);
  const create = () => new Controller({ dir: f.controller.dir, slots: f.controller.slots, backend: { owner: async () => null } });
  const restarted = create(); await restarted.init();
  await assert.rejects(restarted.mutate(request.id, request.digest, 'approve'), /not enabled/);
  await restarted.mutate(request.id, request.digest, 'reject');
  const rejected = create(); await rejected.init();
  assert.equal(rejected.state.deployments[request.id].status, 'rejected');
  assert.equal(rejected.cronApps, false); assert.equal(f.effects(), 0);
});

test('a runtime transport alone does not enable scheduled artifact admission', async t => {
  const f = await fixture(t, false);
  assert.equal((await (await f.get(f.credential.token)).json()).cronApps, false);
  const response = await f.submit(f.credential.token); assert.equal(response.status, 400);
  assert.match((await response.json()).error, /selected runtime/);
  assert.deepEqual(await readdir(join(f.controller.dir, 'artifacts')), []);
  assert.equal(Object.keys(f.controller.state.deployments).length, 0);
  assert.equal(f.effects(), 0);
});
