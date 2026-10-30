import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, link, rm, mkdir, chmod, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import { readPreviewInputs } from '../src/preview/inputs.mjs';
import { issueVerifiedPreviewExecution } from '../src/preview/decision.mjs';
import { createPreviewExecutionAuthority, verifyPreviewExecution } from '../src/preview/execution-authority.mjs';
import { reviewFixture, id } from './fixtures/artifact-review.mjs';

const refused = { code: 'PREVIEW_EXECUTION_REFUSED' };
async function fixture(t, respond, fresh = false) {
  const f = await reviewFixture(t, respond, ['preview']);
  if (fresh) delete f.state.apps['review-app'];
  const result = JSON.parse((await f.run(['prepare', id, '--runtime', 'celld-archive-v9-linux-arm64', '--lifetime-seconds', '60', '--output', f.output])).stdout);
  f.calls.length = 0;
  return { ...f, result, read: () => readPreviewInputs(f.output, result.preparationSha256) };
}
async function metadata(f, name, change) {
  const path = join(f.output, name), value = JSON.parse(await readFile(path)); change(value);
  await writeFile(path, jsonBytes(value));
  return hash(await readFile(join(f.output, 'preview.json')));
}
function decision(f) {
  const authority = createPreviewExecutionAuthority();
  const target = { project: 'preview-input-test', installation: '4'.repeat(64), configSha256: '5'.repeat(64), runtime: f.result.runtime,
    origin: 'https://preview.test', networks: { control: '10.243.1.0/24', 'fleet-1': '10.243.2.0/24', 'fleet-2': '10.243.3.0/24', frontend: '10.243.4.0/24' } };
  return { authority, options: { directory: f.output, expectedPreparationSha256: f.result.preparationSha256, env: f.env, target, privateKey: authority.privateKey } };
}
function sameArtifact(actual, expected) {
  const ordered = value => ({ ...value, files: [...value.files].sort((a, b) => a.path.localeCompare(b.path)) });
  assert.deepEqual(ordered(actual), ordered(expected));
}

for (const fresh of [true, false]) test(`actual prepared bytes verify without executing SQL or application code: fresh=${fresh}`, async t => {
  const f = await fixture(t, undefined, fresh), input = await f.read();
  assert.equal(input.release.app, 'review-app'); assert.equal(input.release.digest, f.after.digest);
  sameArtifact(input.artifact, f.after); assert.equal(input.preparation.executionAuthorized, false);
  assert.equal(Boolean(input.review.active), !fresh); assert.deepEqual(f.calls, []);
  // The verified in-memory artifact cannot change when the source directory does.
  await writeFile(join(f.output, 'proposed/worker/index.js'), 'changed later');
  sameArtifact(input.artifact, f.after);
  await assert.rejects(f.read(), refused);
});

test('noncanonical metadata cannot use a newly supplied raw fingerprint to bypass validation', async t => {
  const f = await fixture(t), path = join(f.output, 'preview.json');
  await writeFile(path, JSON.stringify(JSON.parse(await readFile(path))));
  await assert.rejects(readPreviewInputs(f.output, hash(await readFile(path))), refused);
});

test('changed review bytes do not match the independently selected preparation', async t => {
  const f = await fixture(t); await metadata(f, 'review.json', value => { value.comparison.files = []; });
  await assert.rejects(f.read(), refused);
});

test('a consistently rehashed invented comparison still differs from actual verified artifacts', async t => {
  const f = await fixture(t); await metadata(f, 'review.json', value => { value.comparison.files = []; });
  const reviewSha256 = hash(await readFile(join(f.output, 'review.json')));
  const expected = await metadata(f, 'preview.json', value => { value.source.reviewSha256 = reviewSha256; });
  await assert.rejects(readPreviewInputs(f.output, expected), refused);
});

for (const kind of ['file-symlink', 'directory-symlink', 'hardlink', 'extra-root', 'extra-artifact', 'empty-directory', 'oversized', 'public-root']) test(`prepared input refuses ${kind}`, async t => {
  const f = await fixture(t), worker = join(f.output, 'proposed/worker/index.js');
  if (kind === 'file-symlink') { await rm(worker); await symlink(join(f.output, 'active/worker/index.js'), worker); }
  if (kind === 'directory-symlink') { await rm(join(f.output, 'proposed/worker'), { recursive: true }); await symlink(join(f.output, 'active/worker'), join(f.output, 'proposed/worker')); }
  if (kind === 'hardlink') await link(worker, join(f.root, 'linked-worker'));
  if (kind === 'extra-root') await writeFile(join(f.output, 'extra'), 'unexpected');
  if (kind === 'extra-artifact') await writeFile(join(f.output, 'proposed/assets/extra'), 'unexpected');
  if (kind === 'empty-directory') await mkdir(join(f.output, 'proposed/assets/empty'));
  if (kind === 'oversized') await truncate(worker, 32 * 1024 * 1024 + 1);
  if (kind === 'public-root') await chmod(f.output, 0o755);
  await assert.rejects(f.read(), refused); assert.deepEqual(f.calls, []);
});

test('verified source and exact artifact can produce only a preview execution decision', async t => {
  const f = await fixture(t), { authority, options } = decision(f), before = structuredClone(f.state);
  const result = await issueVerifiedPreviewExecution(options);
  const grant = verifyPreviewExecution(result.envelope, authority.publicKey);
  assert.equal(grant.productionActivation, false); assert.equal(grant.source.digest, f.after.digest);
  sameArtifact(result.artifact, f.after); assert.deepEqual(f.state, before);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.path === '/v1/admin' && call.method === 'GET'));
  assert.ok(f.calls.every(call => call.authorization === `Basic ${Buffer.from('owner:private-admin-password').toString('base64')}`));
});

test('source endpoint mismatch refuses before sending administrator credentials anywhere', async t => {
  const f = await fixture(t), { options } = decision(f);
  const trapCalls = [], trap = createServer((request, response) => { trapCalls.push(request.headers); response.end('{}'); });
  await new Promise(resolve => trap.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => trap.close(resolve)));
  const expected = await metadata(f, 'preview.json', value => { value.source.controller = `http://127.0.0.1:${trap.address().port}`; });
  await assert.rejects(issueVerifiedPreviewExecution({ ...options, expectedPreparationSha256: expected }), refused);
  assert.deepEqual(trapCalls, []); assert.deepEqual(f.calls, []);
});

for (const change of ['status', 'active', 'private-guard']) test(`source ${change} change refuses a new execution decision`, async t => {
  let checking = false;
  const f = await fixture(t, ({ request, state, calls }) => {
    if (checking && request.url === '/v1/admin') {
      if (change === 'status') state.deployments[id].status = 'rejected';
      if (change === 'active') state.apps['review-app'].route = 'paused';
      if (change === 'private-guard' && calls.length === 2) state.deployments[id].private = 'changed-private-diagnostic';
    }
    return false;
  });
  checking = true;
  await assert.rejects(issueVerifiedPreviewExecution(decision(f).options), refused);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});
