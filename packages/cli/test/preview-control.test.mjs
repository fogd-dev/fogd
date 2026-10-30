import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import { artifact } from './fixtures/artifact-review.mjs';
import { createPreviewExecutionAuthority, previewExecutionSha256, signPreviewExecution } from '../src/preview/execution-authority.mjs';
import { issuePreviewExecution } from '../src/preview/execution.mjs';
import { readPreviewControl } from '../src/preview/control-input.mjs';
import { activatePreviewControl, previewControlServer } from '../src/preview/control.mjs';

const refused = { code: 'PREVIEW_EXECUTION_REFUSED' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-preview-control-')); t.after(() => rm(root, { recursive: true, force: true }));
  const trustDirectory = join(root, 'trust'), inputDirectory = join(root, 'input'), directory = join(root, 'controller');
  for (const path of [trustDirectory, inputDirectory, directory]) await mkdir(path, { mode: 0o700 });
  const body = artifact(false), runtime = { family: 'preview-test-candidate', catalogEntrySha256: '1'.repeat(64) }, authority = createPreviewExecutionAuthority();
  const preparation = { schema: 1, kind: 'fogd-preview-preparation', id: '00000000-0000-4000-8000-000000000001', status: 'prepared', preparedAt: new Date(Date.now()-1000).toISOString(),
    source: { controller: 'https://source.test', app: body.app, submission: '00000000-0000-4000-8000-000000000002', digest: body.digest, reviewSha256: '3'.repeat(64) }, runtime,
    policy: { lifetimeSeconds: 60, storage: 'fresh-empty-only', secrets: 'preview-only', requiredSecrets: [], background: 'disabled', network: 'no-external-egress', access: 'owner-authenticated', expiry: 'deny-requests-and-stop-writers', dataPromotion: 'none' }, executionAuthorized: false, capacityReserved: false, scope: 'Fixture only' };
  const target = { project: 'preview-control-test', installation: '4'.repeat(64), configSha256: '5'.repeat(64), runtime, origin: 'https://review-app.preview.test', networks: { control: '10.245.1.0/24', 'fleet-1': '10.245.2.0/24', 'fleet-2': '10.245.3.0/24', frontend: '10.245.4.0/24' } };
  const envelope = issuePreviewExecution(preparation, { expectedPreparationSha256: hash(jsonBytes(preparation)), release: { app: body.app, digest: body.digest, requiredSecrets: [], resources: { script: body.app, durable: { bindings: [] }, d1: [], r2: [] } }, target, privateKey: authority.privateKey });
  const env = { FOGD_PREVIEW_ID: preparation.id.replaceAll('-', ''), FOGD_PREVIEW_STORAGE_PASSWORD: '6'.repeat(64), FOGD_PREVIEW_GATEWAY_TOKEN: '7'.repeat(64), FOGD_PREVIEW_EXPIRES_AT: envelope.grant.expiresAt,
    FOGD_ADMIN_PASSWORD: 'source-admin-never-inherit', AWS_SECRET_ACCESS_KEY: 'source-storage-never-inherit' };
  const trust = { schema: 1, role: 'controller', publicKey: authority.publicKey, expectedGrantSha256: previewExecutionSha256(envelope), preparationSha256: envelope.grant.preparationSha256, target,
    artifactSha256: hash(jsonBytes(body)), secretsSha256: hash(jsonBytes({})), storagePasswordSha256: hash(env.FOGD_PREVIEW_STORAGE_PASSWORD), gatewayTokenSha256: hash(env.FOGD_PREVIEW_GATEWAY_TOKEN) };
  const save = async (name, value) => writeFile(join(inputDirectory, name), jsonBytes(value), { mode: 0o600 });
  await writeFile(join(trustDirectory, 'trust.json'), jsonBytes(trust), { mode: 0o600 });
  await save('execution.json', envelope); await save('artifact.json', body); await save('secrets.json', {});
  const effects = [], owners = {}, backend = { assertUnclaimed: async slot => { effects.push('inspect-empty'); if (owners[slot.id]) throw Error('Not fresh'); },
    owner: async slot => owners[slot.id] || null, hasDeployment: async () => false,
    claim: async (slot, app) => { effects.push('claim'); owners[slot.id] = { app }; },
    publish: async () => { effects.push('publish'); return 'fixture-version'; }, ready: async () => {},
    migrate: async () => { effects.push('migrate'); }, applied: async () => effects.includes('migrate') ? [{ database: 'review-app-db', name: '0001_create.sql' }] : [] };
  const options = { trustDirectory, inputDirectory, env };
  return { root, directory, body, envelope, authority, env, trust, save, effects, backend, options, read: () => readPreviewControl(options) };
}

test('controller input verifies exact signed bytes before initialization and excludes source credentials', async t => {
  const f = await fixture(t), input = await f.read();
  assert.deepEqual(input.artifact, f.body); assert.equal(input.grant.productionActivation, false);
  assert.ok(!JSON.stringify(input.storage).includes('source-')); assert.deepEqual(f.effects, []);
  assert.deepEqual(await readdir(f.directory), []);
});

for (const change of ['artifact', 'secrets', 'signature', 'credentials', 'deadline', 'preview-id']) test(`controller refuses substituted ${change} before target effects`, async t => {
  const f = await fixture(t);
  if (change === 'artifact') { f.body.files[1].data = Buffer.from('other code').toString('base64'); await f.save('artifact.json', f.body); }
  if (change === 'secrets') await f.save('secrets.json', { SOURCE_TOKEN: 'never-copy' });
  if (change === 'signature') await f.save('execution.json', signPreviewExecution(f.envelope.grant, createPreviewExecutionAuthority().privateKey));
  if (change === 'credentials') f.env.FOGD_PREVIEW_STORAGE_PASSWORD = '8'.repeat(64);
  if (change === 'deadline') f.env.FOGD_PREVIEW_EXPIRES_AT = new Date(Date.parse(f.env.FOGD_PREVIEW_EXPIRES_AT)+1000).toISOString();
  if (change === 'preview-id') f.env.FOGD_PREVIEW_ID = '9'.repeat(32);
  await assert.rejects(f.read(), refused); assert.deepEqual(f.effects, []); assert.deepEqual(await readdir(f.directory), []);
});

test('controller activates exactly one verified release on fresh storage without exposing mutation APIs', async t => {
  const f = await fixture(t), input = await f.read(), activated = await activatePreviewControl(input, f);
  assert.equal(Object.keys(activated.controller.state.deployments).length, 1);
  assert.equal(activated.controller.state.apps[f.body.app].active, activated.targetSubmission);
  assert.equal(activated.controller.queueApps, false); assert.equal(activated.controller.cronApps, false);
  const server = previewControlServer(input, activated); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`, headers = { authorization: `Bearer ${f.env.FOGD_PREVIEW_GATEWAY_TOKEN}` };
  assert.equal((await fetch(origin+'/internal/preview')).status, 401);
  const view = await (await fetch(origin+'/internal/preview', { headers })).json();
  assert.equal(view.submission, input.grant.source.submission); assert.equal(view.productionActivation, false); assert.equal(view.digest, f.body.digest);
  const route = await (await fetch(origin+'/internal/route?host=review-app.preview.test', { headers })).json();
  assert.deepEqual(route, { state: 'active', slot: 'slot-1' });
  const before = JSON.stringify(activated.controller.state), effects = [...f.effects];
  for (const path of ['/v1/admin', '/v1/deployments', `/v1/deployments/${activated.targetSubmission}/approve`]) {
    assert.equal((await fetch(origin+path, { method: 'POST', headers, body: '{}' })).status, 404);
  }
  assert.equal(JSON.stringify(activated.controller.state), before); assert.deepEqual(f.effects, effects);
  t.mock.method(Date, 'now', () => Date.parse(input.grant.expiresAt));
  assert.equal((await fetch(origin+'/internal/route?host=review-app.preview.test', { headers })).status, 410);
});

test('retained controller state refuses automatic replay before backend calls', async t => {
  const f = await fixture(t), input = await f.read(); await writeFile(join(f.directory, 'state.json'), 'retained original');
  await assert.rejects(activatePreviewControl(input, f), refused); assert.deepEqual(f.effects, []);
  assert.equal(await readFile(join(f.directory, 'state.json'), 'utf8'), 'retained original');
});

test('failed activation retains controller uncertainty and cannot auto-retry', async t => {
  const f = await fixture(t), input = await f.read(); f.backend.publish = async () => { f.effects.push('publish-uncertain'); throw Error('reply lost'); };
  await assert.rejects(activatePreviewControl(input, f), refused);
  const saved = await readFile(join(f.directory, 'state.json'), 'utf8'), effects = [...f.effects];
  await assert.rejects(activatePreviewControl(input, f), refused);
  assert.deepEqual(f.effects, effects); assert.equal(await readFile(join(f.directory, 'state.json'), 'utf8'), saved);
});

test('a valid owner signature cannot admit a background-capable actual artifact', async t => {
  const f = await fixture(t), body = artifact(true, { queues: { producers: [{ binding: 'JOBS', queue: 'review-app-jobs' }],
    consumers: [{ queue: 'review-app-jobs', max_batch_size: 1, max_batch_timeout: 1, max_retries: 1, retry_delay: 1 }] } });
  const grant = { ...f.envelope.grant, preparationSha256: hash('background fixture preparation'), source: { ...f.envelope.grant.source, digest: body.digest } };
  const envelope = signPreviewExecution(grant, f.authority.privateKey);
  const trust = { ...f.trust, preparationSha256: grant.preparationSha256, expectedGrantSha256: previewExecutionSha256(envelope), artifactSha256: hash(jsonBytes(body)) };
  await writeFile(join(f.options.trustDirectory, 'trust.json'), jsonBytes(trust));
  await f.save('execution.json', envelope); await f.save('artifact.json', body);
  await assert.rejects(f.read(), refused); assert.deepEqual(f.effects, []); assert.deepEqual(await readdir(f.directory), []);
});

test('expired control authority refuses before target initialization', async t => {
  const f = await fixture(t); t.mock.method(Date, 'now', () => Date.parse(f.envelope.grant.expiresAt));
  await assert.rejects(f.read(), refused); assert.deepEqual(f.effects, []); assert.deepEqual(await readdir(f.directory), []);
});

test('only sealed preview secret values are materialized for the exact target release', async t => {
  const f = await fixture(t), values = { API_KEY: 'preview-only-value' };
  const body = { ...f.body, files: [...f.body.files, { path: 'fogd-deployment.json', data: Buffer.from(jsonBytes({ requiredSecrets: ['API_KEY'] })).toString('base64') }] };
  const digest = createHash('sha256');
  for (const file of [...body.files].sort((a, b) => a.path.localeCompare(b.path))) { const bytes = Buffer.from(file.data, 'base64'); digest.update(JSON.stringify([file.path, bytes.length])); digest.update(bytes); }
  body.digest = digest.digest('hex');
  const grant = { ...f.envelope.grant, preparationSha256: hash('secret fixture preparation'), source: { ...f.envelope.grant.source, digest: body.digest }, policy: { ...f.envelope.grant.policy, requiredSecrets: ['API_KEY'] } };
  const envelope = signPreviewExecution(grant, f.authority.privateKey);
  const trust = { ...f.trust, preparationSha256: grant.preparationSha256, expectedGrantSha256: previewExecutionSha256(envelope), artifactSha256: hash(jsonBytes(body)), secretsSha256: hash(jsonBytes(values)) };
  await writeFile(join(f.options.trustDirectory, 'trust.json'), jsonBytes(trust));
  await f.save('execution.json', envelope); await f.save('artifact.json', body); await f.save('secrets.json', values);
  f.backend.publish = async (_slot, directory) => { const config = JSON.parse(await readFile(join(directory, 'wrangler.json'))); assert.equal(config.vars.API_KEY, values.API_KEY); f.effects.push('private-publish'); return 'private-version'; };
  f.backend.applicationReady = async () => { f.effects.push('private-ready'); };
  const activated = await activatePreviewControl(await f.read(), f);
  assert.ok(f.effects.includes('private-ready'));
  assert.equal(JSON.stringify(activated.controller.state).includes(values.API_KEY), false);
  assert.equal(JSON.stringify(body).includes(values.API_KEY), false);
});
