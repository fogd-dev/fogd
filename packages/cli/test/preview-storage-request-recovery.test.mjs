import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, unlink, rename, stat, mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import { preparePreviewStorageRequest, readPreviewStorageRequest } from '../src/preview/storage-request.mjs';
import { inspectPreviewStorageSetup, reconcilePreviewStorageSetup } from '../src/preview/storage-request-recovery.mjs';
import { storageRecoveryRecord } from '../src/preview/storage-request-records.mjs';
import { readPreviewSetup } from '../src/preview/setup-inputs.mjs';
import { reservePreviewHost } from '../src/preview/host-reservations.mjs';
import { previewSetupFixture } from './fixtures/preview-setup.mjs';

const refused = { code: 'PREVIEW_STORAGE_SETUP_RECOVERY_REFUSED' };
async function fixture(t, missing = ['storage.json', 'storage.complete.json']) {
  const f = await previewSetupFixture(t), receipt = await preparePreviewStorageRequest(f.args);
  for (const name of missing) await unlink(join(receipt.directory, name));
  f.hostCalls.length = 0; f.source.calls.length = 0; f.docker.calls.length = 0;
  const input = { ...f.args, candidateEnrollment: false, env: {}, storageDirectory: receipt.directory };
  return { ...f, receipt, input, review: () => inspectPreviewStorageSetup(input), recover: sha => reconcilePreviewStorageSetup({ ...input, expectedReviewSha256: sha }) };
}
const fingerprints = async directory => Object.fromEntries(await Promise.all((await readdir(directory)).map(async name => {
  const path = join(directory, name), info = await stat(path); return [name, { sha256: hash(await readFile(path)), inode: info.ino, device: info.dev }];
})));

test('reviewed recovery fills missing receipt/completion without source credentials, runtime admission or host mutations', async t => {
  const f = await fixture(t), intent = await readFile(join(f.receipt.directory, 'storage.initialization.json')), review = await f.review();
  assert.equal(review.state, 'incomplete'); assert.equal(review.executionAuthorized, false); assert.equal(review.localReceiptPresent, false);
  const result = await f.recover(review.reviewSha256);
  assert.equal(result.storageRequestSha256, f.receipt.storageRequestSha256); assert.equal(result.executionAuthorized, false);
  assert.equal(result.hostStorageActions, 'inspect-only'); assert.equal(result.storageChargeBytes, 1090519040);
  assert.deepEqual(await readFile(join(f.receipt.directory, 'storage.initialization.json')), intent);
  assert.deepEqual((await readdir(f.receipt.directory)).sort(), ['storage.complete.json', 'storage.initialization.json', 'storage.json', 'storage.recovery.json']);
  assert.equal(f.admission.heldProjects, 1); assert.deepEqual(f.source.calls, []);
  assert.ok(f.hostCalls.every(row => ['admission', 'inspect-empty'].includes(row.action)));
  assert.ok(f.docker.calls.every(args => ['info', 'container', 'network', 'volume'].includes(args[0])));
  const setup = await readPreviewSetup(f.args), loaded = await readPreviewStorageRequest(f.receipt.directory, result.storageRequestSha256, setup);
  assert.deepEqual(loaded.storage, f.storage);
});

test('repeating the accepted recovery preserves all bytes/inodes and the original review fingerprint', async t => {
  const f = await fixture(t, ['storage.complete.json']), reviewed = await f.review(), first = await f.recover(reviewed.reviewSha256), before = await fingerprints(f.receipt.directory);
  const observed = await f.review(); assert.equal(observed.state, 'complete'); assert.equal(observed.reviewSha256, reviewed.reviewSha256);
  assert.deepEqual(await f.recover(reviewed.reviewSha256), first); assert.deepEqual(await fingerprints(f.receipt.directory), before);
});

test('an already complete request is observed without adding recovery metadata', async t => {
  const f = await fixture(t, []), before = await fingerprints(f.receipt.directory), review = await f.review();
  assert.equal(review.state, 'complete'); await f.recover(review.reviewSha256);
  assert.deepEqual(await fingerprints(f.receipt.directory), before);
});

test('an existing recovery acknowledgment resumes only the reviewed missing files', async t => {
  const f = await fixture(t), review = await f.review();
  await writeFile(join(f.receipt.directory, 'storage.recovery.json'), jsonBytes(storageRecoveryRecord(review.review)), { mode: 0o600 });
  await writeFile(join(f.receipt.directory, 'storage.json'), jsonBytes(f.storage), { mode: 0o600 });
  const original = await fingerprints(f.receipt.directory), result = await f.recover(review.reviewSha256), after = await fingerprints(f.receipt.directory);
  for (const [name, source] of Object.entries(original)) assert.deepEqual(after[name], source);
  assert.equal(result.storageRequestSha256, f.receipt.storageRequestSha256);
});

test('stale review and replaced original file identities refuse without overwriting local evidence', async t => {
  const f = await fixture(t, ['storage.complete.json']), review = await f.review(), path = join(f.receipt.directory, 'storage.json'), bytes = await readFile(path);
  await rename(path, join(f.artifact.root, 'retained-original-storage.json')); await writeFile(path, bytes, { mode: 0o600 });
  const before = await fingerprints(f.receipt.directory); await assert.rejects(f.recover(review.reviewSha256), refused);
  assert.deepEqual(await fingerprints(f.receipt.directory), before); assert.equal(f.admission.heldProjects, 1);
});

for (const [name, mutate] of Object.entries({
  corruptReceipt: async f => writeFile(join(f.receipt.directory, 'storage.json'), '{'),
  publicIntent: f => chmod(join(f.receipt.directory, 'storage.initialization.json'), 0o644),
  nonemptyHost: f => { const original = f.input.runHost; f.input.runHost = async (args, extra) => { if (JSON.parse(extra.inputText).action === 'inspect-empty') throw Error('PRIVATE_HOST_STATE'); return original(args, extra); }; },
  pendingHost: f => { f.admission.pending = true; f.admission.admissionOpen = false; },
})) test(`recovery ${name} refuses and retains the original charge`, async t => {
  const f = await fixture(t, ['storage.complete.json']); await mutate(f); const before = await fingerprints(f.receipt.directory);
  await assert.rejects(f.review(), error => error.code === refused.code && !error.message.includes('PRIVATE_'));
  await assert.rejects(f.recover('f'.repeat(64)), refused);
  assert.deepEqual(await fingerprints(f.receipt.directory), before); assert.equal(f.admission.heldProjects, 1);
  assert.ok(f.hostCalls.every(row => ['admission', 'inspect-empty'].includes(row.action)));
});

test('a preview already present in the memory ledger cannot be reconciled as fresh setup', async t => {
  const f = await fixture(t), profile = JSON.parse(await readFile(join(f.profile.directory, 'profile.json')));
  await reservePreviewHost({ root: profile.root, plan: f.artifact.plan, run: f.docker.run });
  await assert.rejects(f.review(), refused); assert.equal((await readdir(join(profile.root, hash(profile.engineId), 'holds'))).length, 1);
  assert.deepEqual(await readdir(f.receipt.directory), ['storage.initialization.json']);
});

test('a corrupt acknowledgment remains refusing after partial recovery', async t => {
  const f = await fixture(t), review = await f.review(); await f.recover(review.reviewSha256);
  await writeFile(join(f.receipt.directory, 'storage.recovery.json'), '{');
  await assert.rejects(f.review(), refused); await assert.rejects(f.recover(review.reviewSha256), refused);
  const setup = await readPreviewSetup(f.args);
  await assert.rejects(readPreviewStorageRequest(f.receipt.directory, f.receipt.storageRequestSha256, setup), { code: 'PREVIEW_STORAGE_REQUEST_REFUSED' });
});

test('concurrent recovery converges through the profile fence without host provisioning', async t => {
  const f = await fixture(t), review = await f.review(), results = await Promise.allSettled([f.recover(review.reviewSha256), f.recover(review.reviewSha256)]);
  assert.ok(results.some(row => row.status === 'fulfilled'));
  for (const row of results) if (row.status === 'rejected') assert.equal(row.reason.code, refused.code);
  assert.equal((await f.review()).state, 'complete'); assert.ok(f.hostCalls.every(row => ['admission', 'inspect-empty'].includes(row.action)));
});

test('real recovery CLI inspects and reconciles a candidate without source credentials or runtime permission', async t => {
  const f = await fixture(t), tools = join(f.artifact.root, 'tools'), calls = join(f.artifact.root, 'calls.jsonl'); await mkdir(tools);
  const record = `await appendFile(${JSON.stringify(calls)},JSON.stringify({args:process.argv.slice(2),ambient:Object.keys(process.env).filter(k=>k.startsWith('FOGD_')||k.startsWith('DOCKER_'))})+'\\n');`;
  await writeFile(join(tools, 'docker'), `#!${process.execPath}\nimport{appendFile}from'node:fs/promises';${record}const args=process.argv.slice(2);if(args[0]!=='--context'||args[1]!=='setup-owner')process.exit(2);if(args[2]==='info')console.log(${JSON.stringify(JSON.stringify(f.docker.host))});else if(args[3]==='ls')console.log('');else process.exit(3);`, { mode: 0o700 });
  await writeFile(join(tools, 'ssh'), `#!${process.execPath}\nimport{appendFile}from'node:fs/promises';${record}let raw='';for await(const chunk of process.stdin)raw+=chunk;const request=JSON.parse(JSON.parse(raw).input);if(request.action==='admission')console.log(JSON.stringify({ok:true,admission:${JSON.stringify(f.admission)}}));else if(request.action==='inspect-empty')console.log(JSON.stringify({ok:true,storage:${JSON.stringify(f.storage.storage)}}));else process.exit(4);`, { mode: 0o700 });
  const env = { ...process.env, PATH: tools, DOCKER_HOST: 'tcp://wrong-host', FOGD_ADMIN_PASSWORD: 'PRIVATE_WRONG_PASSWORD' }, bin = new URL('../bin/fogd.js', import.meta.url).pathname;
  const common = ['--profile', f.profile.directory, '--expected-profile', f.profile.profileSha256, '--preparation', f.args.directory, '--expected-preparation', f.args.expectedPreparationSha256, '--storage-request', f.receipt.directory, '--storage-host', 'owned-linux'];
  const run = (action, extra = []) => promisify(execFile)(process.execPath, [bin, 'preview', 'storage', action, ...common, ...extra], { env, timeout: 30000 });
  const inspected = JSON.parse((await run('inspect')).stdout), result = JSON.parse((await run('reconcile', ['--expected-review', inspected.reviewSha256])).stdout);
  assert.equal(result.executionAuthorized, false); assert.equal(result.hostStorageActions, 'inspect-only'); assert.equal(result.storageRequestSha256, f.receipt.storageRequestSha256);
  assert.deepEqual(f.source.calls, []); assert.ok((await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse).every(row => row.ambient.length === 0));
  const before = await fingerprints(f.receipt.directory); await assert.rejects(run('reconcile', ['--expected-review', 'f'.repeat(64)])); assert.deepEqual(await fingerprints(f.receipt.directory), before);
});


test('recovery acknowledgments bind the identity of every originally present record', async t => {
  const f = await fixture(t, ['storage.complete.json']), review = await f.review(); await f.recover(review.reviewSha256);
  const path = join(f.receipt.directory, 'storage.json'), original = await readFile(path);
  await rename(path, join(f.artifact.root, 'retained-acknowledged-storage.json')); await writeFile(path, original, { mode: 0o600 });
  const before = await fingerprints(f.receipt.directory); await assert.rejects(f.review(), refused);
  await assert.rejects(f.recover(review.reviewSha256), refused); assert.deepEqual(await fingerprints(f.receipt.directory), before);
});
