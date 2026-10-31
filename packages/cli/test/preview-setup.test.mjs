import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, stat, chmod, cp, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { preparePreviewStorageRequest } from '../src/preview/storage-request.mjs';
import { createProfilePreviewRequest } from '../src/preview/request-setup.mjs';
import { readPreviewLaunchRequest } from '../src/preview/launch-request.mjs';
import { readPreviewRequestSettings } from '../src/preview/setup-command.mjs';
import { previewSetupFixture } from './fixtures/preview-setup.mjs';
import { id } from './fixtures/artifact-review.mjs';
import { hash } from '../src/build-cache/paths.mjs';

const storageRefused = { code: 'PREVIEW_STORAGE_REQUEST_REFUSED' }, requestRefused = { code: 'PREVIEW_REQUEST_SETUP_REFUSED' };
const requestArgs = (f, receipt) => ({ ...f.args, output: join(f.artifact.root, 'launch-request'), settings: f.settings,
  storageDirectory: receipt.directory, expectedStorageRequestSha256: receipt.storageRequestSha256 });
const load = receipt => readPreviewLaunchRequest(receipt.directory, receipt.requestSha256, { candidateEnrollment: true });
async function settingsFile(f) {
  const paths = {};
  for (const [role, pair] of Object.entries(f.settings.tls)) {
    paths[role] = {};
    for (const [field, value] of Object.entries(pair)) {
      const name = role + '.' + field; await writeFile(join(f.artifact.root, name), value, { mode: 0o600 });
      paths[role][field + 'File'] = name;
    }
  }
  const path = join(f.artifact.root, 'settings.json');
  await writeFile(path, JSON.stringify({ ...f.settings, tls: paths }), { mode: 0o600 });
  return path;
}

test('profile storage preparation and signed request creation retain separate storage and memory budgets', async t => {
  const f = await previewSetupFixture(t), before = structuredClone(f.source.state), receipt = await preparePreviewStorageRequest(f.args);
  assert.equal(receipt.runtimeStarted, false); assert.equal(receipt.memoryReserved, false); assert.equal(receipt.executionAuthorized, false);
  assert.equal(hash(await readFile(join(receipt.directory, 'storage.complete.json'))), receipt.storageRequestSha256);
  for (const name of await readdir(receipt.directory)) assert.equal((await stat(join(receipt.directory, name))).mode & 0o7777, 0o600);
  assert.equal(f.admission.heldProjects, 1); assert.equal(f.admission.remainingProjects, 1);
  const request = await createProfilePreviewRequest(requestArgs(f, receipt)), { configuration } = await load(request);
  assert.deepEqual(configuration.plan.request.storage, f.storage); assert.equal(configuration.envelope.grant.productionActivation, false);
  assert.notEqual(configuration.bundle.ingress.accessKey, configuration.secretValues.gatewayToken);
  assert.equal(configuration.root, join(f.profile.directory, 'ledger'));
  const ledger = join(configuration.root, hash(f.docker.host.ID));
  assert.deepEqual(await readdir(join(ledger, 'holds')), []); assert.deepEqual(await readdir(join(ledger, 'allocations')), []);
  assert.deepEqual(f.source.state, before); assert.ok(f.source.calls.every(value => value.method === 'GET'));
  assert.ok(f.docker.calls.every(args => ['info', 'container', 'network', 'volume'].includes(args[0])));
  assert.equal(JSON.stringify(configuration).includes(f.source.env.FOGD_ADMIN_PASSWORD), false);
});

test('ordinary candidate storage and request setup refuse before source, host or output effects', async t => {
  const f = await previewSetupFixture(t);
  await assert.rejects(preparePreviewStorageRequest({ ...f.args, candidateEnrollment: false }), storageRefused);
  await assert.rejects(createProfilePreviewRequest({ ...requestArgs(f, { directory: '/absent', storageRequestSha256: 'f'.repeat(64) }), candidateEnrollment: false }), requestRefused);
  assert.deepEqual(f.hostCalls, []); assert.deepEqual(f.docker.calls, []); assert.deepEqual(f.source.calls, []);
  await assert.rejects(stat(f.args.output), { code: 'ENOENT' });
});

for (const [name, change] of Object.entries({
  capacity: f => { f.admission.space.availableBytes = 0; f.admission.admissionOpen = false; },
  withdrawnSource: f => { f.source.state.deployments[id].status = 'rejected'; },
  profileFingerprint: f => { f.args.expectedProfileSha256 = 'f'.repeat(64); },
})) test(`storage setup ${name} refuses without provisioning or local output`, async t => {
  const f = await previewSetupFixture(t); change(f); await assert.rejects(preparePreviewStorageRequest(f.args), storageRefused);
  assert.ok(!f.hostCalls.some(value => value.action === 'prepare')); await assert.rejects(stat(f.args.output), { code: 'ENOENT' });
});

test('unknown storage effects preserve original intent and charge while same-output replay never reaches a transport', async t => {
  const f = await previewSetupFixture(t), runHost = f.args.runHost;
  f.args.runHost = async (args, options) => { const result = await runHost(args, options); if (JSON.parse(options.inputText).action === 'prepare') throw Error('PRIVATE_HOST_RESULT'); return result; };
  await assert.rejects(preparePreviewStorageRequest(f.args), error => error.code === storageRefused.code && !error.message.includes('PRIVATE_'));
  assert.equal(f.admission.heldProjects, 1); assert.deepEqual(await readdir(f.args.output), ['storage.initialization.json']);
  const count = f.hostCalls.length, original = await readFile(join(f.args.output, 'storage.initialization.json'));
  await assert.rejects(preparePreviewStorageRequest(f.args), storageRefused); assert.equal(f.hostCalls.length, count);
  assert.deepEqual(await readFile(join(f.args.output, 'storage.initialization.json')), original);
});

test('lost empty-storage inspection retains its receipt and cannot become completed request input', async t => {
  const f = await previewSetupFixture(t), runHost = f.args.runHost;
  f.args.runHost = async (args, options) => { if (JSON.parse(options.inputText).action === 'inspect-empty') throw Error('unavailable inspection'); return runHost(args, options); };
  await assert.rejects(preparePreviewStorageRequest(f.args), storageRefused);
  assert.deepEqual((await readdir(f.args.output)).sort(), ['storage.initialization.json', 'storage.json']);
  await assert.rejects(createProfilePreviewRequest(requestArgs(f, { directory: f.args.output, storageRequestSha256: 'f'.repeat(64) })), requestRefused);
  assert.equal(f.admission.heldProjects, 1);
});

for (const [name, change] of Object.entries({
  changedStorage: async (f, r) => writeFile(join(r.directory, 'storage.json'), '{}\n'),
  changedIntent: async (f, r) => writeFile(join(r.directory, 'storage.initialization.json'), '{}\n'),
  missingCompletion: async (f, r) => unlink(join(r.directory, 'storage.complete.json')),
  publicReceipt: async (f, r) => chmod(join(r.directory, 'storage.json'), 0o644),
  relocatedReceipt: async (f, r) => { const moved = join(f.artifact.root, 'moved-storage'); await cp(r.directory, moved, { recursive: true }); return moved; },
})) test(`request creation refuses ${name} while retaining the storage charge`, async t => {
  const f = await previewSetupFixture(t), receipt = await preparePreviewStorageRequest(f.args), directory = await change(f, receipt) || receipt.directory;
  await assert.rejects(createProfilePreviewRequest({ ...requestArgs(f, receipt), storageDirectory: directory }), requestRefused);
  assert.equal(f.admission.heldProjects, 1); await assert.rejects(stat(join(f.artifact.root, 'launch-request')), { code: 'ENOENT' });
});

test('a receipt from another profile or preparation cannot fund a new signed request', async t => {
  const first = await previewSetupFixture(t), receipt = await preparePreviewStorageRequest(first.args), second = await previewSetupFixture(t);
  await assert.rejects(createProfilePreviewRequest(requestArgs(second, receipt)), requestRefused);
  assert.equal(second.admission.heldProjects, 0); assert.deepEqual(second.source.calls, []);
});

test('invalid TLS, secrets or settings cannot create a request or consume another storage slot', async t => {
  const f = await previewSetupFixture(t), receipt = await preparePreviewStorageRequest(f.args), args = requestArgs(f, receipt);
  for (const settings of [{ ...f.settings, candidateEnrollment: true }, { ...f.settings, secrets: { inherited: 'PRIVATE_SOURCE_VALUE' } },
    { ...f.settings, tls: { ...f.settings.tls, ingress: { cert: 'invalid', key: 'PRIVATE_TLS_KEY' } } }]) {
    await assert.rejects(createProfilePreviewRequest({ ...args, settings }), error => error.code === requestRefused.code && !error.message.includes('PRIVATE_'));
  }
  assert.equal(f.admission.heldProjects, 1); await assert.rejects(stat(args.output), { code: 'ENOENT' });
});

test('request setup snapshots caller settings and source credentials across host observations', async t => {
  const f = await previewSetupFixture(t), receipt = await preparePreviewStorageRequest(f.args), args = requestArgs(f, receipt), origin = args.settings.origin, run = args.run;
  args.run = async (...values) => { args.settings.origin = 'https://changed.test'; args.env.FOGD_ADMIN_PASSWORD = 'changed'; return run(...values); };
  const result = await createProfilePreviewRequest(args), { configuration } = await load(result);
  assert.equal(configuration.plan.request.origin, origin);
});

test('request output cannot modify the profile, preparation or sealed storage request', async t => {
  const f = await previewSetupFixture(t), receipt = await preparePreviewStorageRequest(f.args);
  for (const parent of [f.profile.directory, f.args.directory, receipt.directory]) await assert.rejects(createProfilePreviewRequest({ ...requestArgs(f, receipt), output: join(parent, 'nested-request') }), requestRefused);
  assert.equal(f.admission.heldProjects, 1);
});

test('private settings accept ordinary JSON and load bounded owner TLS files without exposing parse failures', async t => {
  const f = await previewSetupFixture(t), path = await settingsFile(f), value = await readPreviewRequestSettings(path);
  assert.deepEqual(value, f.settings);
  await writeFile(path, '{"PRIVATE_CONFIG_VALUE":');
  await assert.rejects(readPreviewRequestSettings(path), error => error.code === 'PREVIEW_REQUEST_SETTINGS_REFUSED' && !error.message.includes('PRIVATE_'));
});

test('real CLI setup commands cannot enable the current candidate through flags, settings or environment', async t => {
  const f = await previewSetupFixture(t), receipt = await preparePreviewStorageRequest(f.args), settings = await settingsFile(f), tools = join(f.artifact.root, 'tools'), marker = join(f.artifact.root, 'unexpected-calls'); await mkdir(tools);
  for (const name of ['docker', 'ssh']) await writeFile(join(tools, name), `#!${process.execPath}\nimport{appendFile}from'node:fs/promises';await appendFile(${JSON.stringify(marker)},'unexpected');process.exit(3);`, { mode: 0o700 });
  const env = { ...process.env, ...f.source.env, PATH: tools, FOGD_PREVIEW_CANDIDATE_ENROLLMENT: 'true' }, bin = new URL('../bin/fogd.js', import.meta.url).pathname, run = promisify(execFile);
  const common = ['--profile', f.profile.directory, '--expected-profile', f.profile.profileSha256, '--preparation', f.args.directory, '--expected-preparation', f.args.expectedPreparationSha256, '--storage-host', 'owned-linux', '--output', join(f.artifact.root, 'public-output')];
  for (const args of [[bin, 'preview', 'storage', 'prepare', ...common], [bin, 'preview', 'request', ...common, '--storage-request', receipt.directory, '--expected-storage-request', receipt.storageRequestSha256, '--settings', settings]]) {
    await assert.rejects(run(process.execPath, args, { env }), error => { assert.match(error.stderr, /refused/); assert.equal(error.stdout, ''); return true; });
    await assert.rejects(run(process.execPath, [...args, '--candidate-enrollment'], { env }));
  }
  await assert.rejects(readFile(marker), { code: 'ENOENT' }); assert.equal(f.admission.heldProjects, 1);
});


test('background-capable prepared bindings refuse before consuming a retained storage slot', async t => {
  const f = await previewSetupFixture(t, { durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }] });
  await assert.rejects(preparePreviewStorageRequest(f.args), storageRefused);
  assert.ok(!f.hostCalls.some(value => value.action === 'prepare')); assert.equal(f.admission.heldProjects, 0);
  assert.deepEqual(f.source.calls, []); await assert.rejects(stat(f.args.output), { code: 'ENOENT' });
});
