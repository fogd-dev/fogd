import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat, mkdir, chmod, rename, symlink, link, unlink, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { createPreviewLaunchRequest, readPreviewLaunchRequest } from '../src/preview/launch-request.mjs';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import { authorizePreviewExecution } from '../src/preview/execution.mjs';
import { previewPlanTarget } from '../src/preview/plan.mjs';
import { previewLaunchFixture } from './fixtures/preview-launch.mjs';
import { id } from './fixtures/artifact-review.mjs';

const refused = { code: 'PREVIEW_LAUNCH_REQUEST_REFUSED' };
async function fixture(t) {
  const f = await previewLaunchFixture(t);
  return { ...f, request: { root: f.args.root, directory: f.args.directory,
    expectedPreparationSha256: f.args.plan.request.preparationSha256,
    engineId: f.args.plan.request.engineId, storage: f.args.plan.request.storage,
    runtime: f.args.runtime, candidateEnrollment: true, origin: f.args.plan.request.origin,
    subnets: f.args.plan.request.subnets, tls: { gateway: f.args.bundle.gateway.tls, ingress: f.args.bundle.ingress.tls },
    dockerContext: f.ownerControl.dockerContext, output: join(f.input.root, 'launch-request'),
    env: f.args.env, runStorageHost: f.args.runStorageHost } };
}
const load = receipt => readPreviewLaunchRequest(receipt.directory, receipt.requestSha256, { candidateEnrollment: true });

test('owner setup creates a complete private request with generated credentials and an exact verified grant', async t => {
  const f = await fixture(t), before = structuredClone(f.source.state), receipt = await createPreviewLaunchRequest(f.request);
  const { configuration } = await load(receipt), files = (await readdir(receipt.directory)).sort();
  assert.deepEqual(files, ['access.json', 'launch.json', 'request.complete.json']);
  assert.equal(receipt.runtimeStarted, false); assert.equal(receipt.memoryReserved, false); assert.equal(receipt.productionActivation, false);
  for (const name of files) assert.equal((await stat(join(receipt.directory, name))).mode & 0o777, 0o600);
  assert.equal((await stat(receipt.directory)).mode & 0o777, 0o700);
  assert.equal(hash(await readFile(join(receipt.directory, 'launch.json'))), receipt.requestSha256);
  const grant = authorizePreviewExecution(configuration.envelope, { publicKey: configuration.publicKey, expectedGrantSha256: configuration.expectedGrantSha256,
    preparationSha256: f.request.expectedPreparationSha256, target: previewPlanTarget(configuration.plan) });
  assert.equal(grant.productionActivation, false); assert.equal(grant.source.digest, f.source.after.digest);
  const access = JSON.parse(await readFile(receipt.accessFile));
  assert.equal(hash(access.accessKey), configuration.plan.request.fingerprints.viewerAccessKey);
  assert.equal(access.expiresAt, grant.expiresAt); assert.equal(access.origin, configuration.plan.request.origin);
  assert.equal(configuration.bundle.ingress.upstreamCA, configuration.bundle.gateway.tls.cert);
  assert.deepEqual(configuration.bundle.secrets, {});
  assert.ok(!Object.hasOwn(configuration, 'privateKey') && !Object.hasOwn(configuration, 'env'));
  assert.equal((await readFile(join(receipt.directory, 'launch.json'), 'utf8')).includes('private-admin-password'), false);
  assert.equal(JSON.stringify(receipt).includes(access.accessKey), false);
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(join(f.host, 'holds')), []);
  assert.deepEqual(f.source.state, before); assert.ok(f.source.calls.every(call => call.method === 'GET'));
});

test('separate explicit requests generate different credentials, authorities and grant identities', async t => {
  const f = await fixture(t), a = (await load(await createPreviewLaunchRequest(f.request))).configuration;
  const b = (await load(await createPreviewLaunchRequest({ ...f.request, output: join(f.input.root, 'second-request') }))).configuration;
  assert.notEqual(a.publicKey, b.publicKey); assert.notEqual(a.envelope.grant.id, b.envelope.grant.id);
  for (const name of ['storagePassword', 'gatewayToken']) { assert.match(a.secretValues[name], /^[a-f0-9]{64}$/); assert.notEqual(a.secretValues[name], b.secretValues[name]); }
  assert.notEqual(a.bundle.ingress.accessKey, b.bundle.ingress.accessKey);
});

test('ordinary candidate admission and missing fingerprints refuse without source or storage effects', async t => {
  const f = await fixture(t); let calls = 0;
  const runStorageHost = async () => { calls++; throw Error('must not inspect storage'); };
  await assert.rejects(createPreviewLaunchRequest({ ...f.request, candidateEnrollment: false, runStorageHost }), refused);
  await assert.rejects(createPreviewLaunchRequest({ ...f.request, expectedPreparationSha256: '', runStorageHost }), refused);
  assert.equal(calls, 0); assert.deepEqual(f.source.calls, []);
  await assert.rejects(stat(f.request.output), { code: 'ENOENT' });
});

test('invalid TLS, preview secrets and placement cannot produce a launch request', async t => {
  const f = await fixture(t);
  for (const extra of [{ tls: { ...f.request.tls, ingress: { cert: 'bad', key: 'PRIVATE_TLS_KEY' } } },
    { secrets: { inherited: 'PRIVATE_SOURCE_SECRET' } }, { origin: 'https://other.test' }, { engineId: 'wrong-engine' }]) {
    await assert.rejects(createPreviewLaunchRequest({ ...f.request, ...extra }), error => error.code === refused.code && !error.message.includes('PRIVATE_'));
  }
  assert.deepEqual(f.source.calls, []); assert.deepEqual(f.calls, []);
  await assert.rejects(stat(f.request.output), { code: 'ENOENT' });
});

test('storage refusal or a changed source keeps request output absent and private diagnostics suppressed', async t => {
  const f = await fixture(t);
  await assert.rejects(createPreviewLaunchRequest({ ...f.request, runStorageHost: async () => { throw Error('PRIVATE_STORAGE_DETAIL'); } }),
    error => error.code === refused.code && !error.message.includes('PRIVATE_STORAGE_DETAIL'));
  assert.deepEqual(f.source.calls, []);
  f.source.state.deployments[id].status = 'rejected';
  await assert.rejects(createPreviewLaunchRequest(f.request), refused);
  await assert.rejects(stat(f.request.output), { code: 'ENOENT' });
});

test('caller edits during storage inspection cannot change the selected placement or source credentials', async t => {
  const f = await fixture(t), expectedContext = f.request.dockerContext, expectedOrigin = f.request.origin, original = f.request.runStorageHost;
  f.request.runStorageHost = async (...args) => { f.request.dockerContext = 'changed-context'; f.request.origin = 'https://changed.test'; f.request.env.FOGD_ADMIN_PASSWORD = 'changed-password'; return original(...args); };
  const { configuration } = await load(await createPreviewLaunchRequest(f.request));
  assert.equal(configuration.ownerControl.dockerContext, expectedContext); assert.equal(configuration.plan.request.origin, expectedOrigin);
  assert.ok(f.source.calls.every(call => call.authorization === 'Basic ' + Buffer.from('owner:private-admin-password').toString('base64')));
});

test('output collisions during verification preserve existing files and never overwrite them', async t => {
  const f = await fixture(t), original = f.request.runStorageHost;
  f.request.runStorageHost = async (...args) => { await mkdir(f.request.output, { mode: 0o700 }); await writeFile(join(f.request.output, 'retain.txt'), 'keep'); return original(...args); };
  await assert.rejects(createPreviewLaunchRequest(f.request), refused);
  assert.equal(await readFile(join(f.request.output, 'retain.txt'), 'utf8'), 'keep');
  assert.deepEqual(await readdir(f.request.output), ['retain.txt']);
});

for (const [name, change] of Object.entries({
  changedRequest: async (f, r) => writeFile(join(r.directory, 'launch.json'), '{}\n'),
  changedAccess: async (f, r) => writeFile(r.accessFile, '{}\n'),
  missingCompletion: async (f, r) => unlink(join(r.directory, 'request.complete.json')),
  publicFile: async (f, r) => chmod(join(r.directory, 'launch.json'), 0o644),
  extraMember: async (f, r) => writeFile(join(r.directory, 'unknown.json'), '{}\n'),
  symlink: async (f, r) => { const target = join(f.input.root, 'retained-input'); await rename(join(r.directory, 'launch.json'), target); await symlink(target, join(r.directory, 'launch.json')); },
  hardlink: async (f, r) => link(join(r.directory, 'launch.json'), join(f.input.root, 'second-link')),
})) test(`launch request loading refuses ${name} without host effects`, async t => {
  const f = await fixture(t), receipt = await createPreviewLaunchRequest(f.request); await change(f, receipt);
  await assert.rejects(load(receipt), refused); assert.deepEqual(f.calls, []);
});

test('original fingerprint, runtime admission, expiry and fixed owner-control location remain load gates', async t => {
  const f = await fixture(t), receipt = await createPreviewLaunchRequest(f.request);
  await assert.rejects(readPreviewLaunchRequest(receipt.directory, 'f'.repeat(64), { candidateEnrollment: true }), refused);
  await assert.rejects(readPreviewLaunchRequest(receipt.directory, receipt.requestSha256), refused);
  const moved = join(f.input.root, 'moved'); await cp(receipt.directory, moved, { recursive: true });
  await assert.rejects(readPreviewLaunchRequest(moved, receipt.requestSha256, { candidateEnrollment: true }), refused);
  await mkdir(receipt.ownerControlDirectory, { mode: 0o700 }); await load(receipt);
  t.mock.method(Date, 'now', () => Date.parse(receipt.expiresAt) + 1);
  await assert.rejects(load(receipt), refused);
});

test('candidate admission cannot be supplied inside the persisted launch input', async t => {
  const f = await fixture(t), receipt = await createPreviewLaunchRequest(f.request), file = join(receipt.directory, 'launch.json');
  const value = JSON.parse(await readFile(file)); value.candidateEnrollment = true;
  await writeFile(file, jsonBytes(value));
  await assert.rejects(readPreviewLaunchRequest(receipt.directory, hash(jsonBytes(value))), refused);
});
