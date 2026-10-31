import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reviewFixture, artifact, id, hash } from './fixtures/artifact-review.mjs';
import { prepareCandidatePreview, previewLaunchRuntime } from './fixtures/preview-launch.mjs';
import { previewRuntimeFamily } from '../src/preview/runtime-catalog.mjs';
import { jsonBytes } from '../src/build-cache/paths.mjs';

const family = 'celld-archive-v9-linux-arm64';
const args = (f, ttl = '900', runtime = family) => ['prepare', id, '--runtime', runtime, `--lifetime-seconds=${ttl}`, '--output', f.output];
const fixture = (t, respond) => reviewFixture(t, respond, ['preview']);

test('owned candidate preparation binds the preview catalog directly without an execution grant', async t => {
  const f = await fixture(t), runtime = previewRuntimeFamily(previewLaunchRuntime, { candidateEnrollment: true });
  const prepared = await prepareCandidatePreview(f);
  assert.deepEqual(prepared.runtime, { family: runtime.id, catalogEntrySha256: hash(jsonBytes(runtime)) });
  assert.equal(prepared.executionAuthorized, false); assert.equal(prepared.capacityReserved, false);
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

test('CLI preparation cannot enroll a candidate preview runtime or accept a candidate bypass flag', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(args(f, '900', previewLaunchRuntime)));
  await assert.rejects(f.run([...args(f, '900', previewLaunchRuntime), '--candidate-enrollment']));
  assert.deepEqual(f.calls, []); await assert.rejects(access(f.output), { code: 'ENOENT' });
});

test('preview preparation binds verified proposed bytes without executing code or changing production', async t => {
  const f = await fixture(t), before = structuredClone(f.state);
  const result = JSON.parse((await f.run(args(f))).stdout);
  const bytes = await readFile(join(f.output, 'preview.json'));
  const { directory, preparationSha256, ...saved } = result;
  assert.deepEqual(JSON.parse(bytes), saved); assert.equal(hash(bytes), preparationSha256);
  assert.equal(directory, f.output); assert.equal(saved.status, 'prepared');
  assert.deepEqual(saved.source, { controller: f.env.FOGD_SERVER, app: f.after.app, submission: id, digest: f.after.digest,
    reviewSha256: hash(await readFile(join(f.output, 'review.json'))) });
  assert.equal(saved.runtime.family, family);
  assert.equal(saved.executionAuthorized, false); assert.equal(saved.capacityReserved, false);
  assert.equal(saved.policy.lifetimeSeconds, 900); assert.equal(saved.policy.storage, 'fresh-empty-only');
  assert.equal(saved.policy.network, 'no-external-egress'); assert.equal(saved.policy.dataPromotion, 'none');
  assert.deepEqual(f.state, before); assert.ok(f.calls.every(call => call.method === 'GET'));
  assert.equal((await stat(f.output)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.output, 'preview.json'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(f.output, 'proposed/worker/index.js'), 'utf8'), "throw new Error('must not execute new application code');");
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('a fresh app prepares without inheriting an active app or production data', async t => {
  const f = await fixture(t); delete f.state.apps['review-app'];
  const result = JSON.parse((await f.run(args(f, '60'))).stdout);
  assert.equal(result.policy.lifetimeSeconds, 60);
  await assert.rejects(access(join(f.output, 'active')), { code: 'ENOENT' });
  assert.equal(f.calls.length, 3);
});

for (const ttl of ['0', '59', '3601', '1e3', '60.0', '-60']) test(`invalid preview lifetime ${ttl} refuses before network or output`, async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(args(f, ttl)), /lifetime must be an integer/);
  assert.deepEqual(f.calls, []); await assert.rejects(access(f.output), { code: 'ENOENT' });
});

for (const runtime of ['unknown', 'celld-approval-v7-linux-arm64', 'celld-approval-v8-linux-arm64']) test(`unsupported preview runtime ${runtime} refuses before download`, async t => {
  const f = await fixture(t); await assert.rejects(f.run(args(f, '900', runtime)));
  assert.deepEqual(f.calls, []); await assert.rejects(access(f.output), { code: 'ENOENT' });
});

test('upload credentials alone cannot prepare a preview', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(args(f), { FOGD_ADMIN_PASSWORD: '' }), /Set FOGD_ADMIN_PASSWORD/);
  assert.deepEqual(f.calls, []); await assert.rejects(access(f.output), { code: 'ENOENT' });
});

test('existing preparation output is never overwritten', async t => {
  const f = await fixture(t); await writeFile(f.output, 'retained');
  await assert.rejects(f.run(args(f)), /output already exists/);
  assert.equal(await readFile(f.output, 'utf8'), 'retained'); assert.deepEqual(f.calls, []);
});

test('a changed submission during download retains partial copies but no preview preparation', async t => {
  const f = await fixture(t, ({ request, state, calls }) => {
    if (request.url === '/v1/admin' && calls.length > 1) state.deployments[id].status = 'rejected';
    return false;
  });
  await assert.rejects(f.run(args(f)), /state changed during review/);
  await access(join(f.output, 'proposed/worker/index.js'));
  await assert.rejects(access(join(f.output, 'preview.json')), { code: 'ENOENT' });
});

for (const status of ['rejected', 'active']) test(`${status} submissions cannot become a new preview preparation`, async t => {
  const f = await fixture(t); f.state.deployments[id].status = status;
  await assert.rejects(f.run(args(f)), /no longer proposed/);
  await assert.rejects(access(join(f.output, 'preview.json')), { code: 'ENOENT' });
  assert.ok(f.calls.every(call => call.method === 'GET'));
});

for (const extra of [
  { triggers: { crons: ['* * * * *'] } },
  { queues: { producers: [{ binding: 'JOBS', queue: 'review-app-jobs' }], consumers: [{ queue: 'review-app-jobs', max_batch_size: 1, max_batch_timeout: 1, max_retries: 1, retry_delay: 1 }] } },
]) test(`background declarations refuse preparation: ${Object.keys(extra)[0]}`, async t => {
  const proposed = artifact(true, extra);
  const f = await fixture(t, ({ request, response, state }) => {
    state.deployments[id].digest = proposed.digest;
    if (request.url !== `/v1/deployments/${id}/artifact`) return false;
    response.end(JSON.stringify(proposed)); return true;
  });
  await assert.rejects(f.run(args(f)), /supports HTTP applications only/);
  await assert.rejects(access(join(f.output, 'preview.json')), { code: 'ENOENT' });
  assert.ok(f.calls.every(call => call.method === 'GET'));
});
