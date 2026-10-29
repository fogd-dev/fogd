import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, unlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_UPLOAD } from '@fogd/runtime/manifest';
import { decisionFixture } from './fixtures/decision-controller.mjs';

async function selected(http, request) {
  const response = await http.get(`/v1/deployments/${request.id}/review`);
  assert.equal(response.status, 200); return response.json();
}
const fileUrl = (request, review, path, offset) => `/admin/review/${request.id}/file?${new URLSearchParams({ path, review, ...(offset === undefined ? {} : { offset: String(offset) }) })}`;

test('verified first-submission review is admin-only, read-only and escapes authored code in before/after previews', async t => {
  const f = await decisionFixture(t), code = 'globalThis.reviewMustNeverRun=true; export default {fetch(){return new Response("</pre><script>window.reviewPwned=true</script>")}}';
  const request = await f.submit('demo', { files: { 'dist/ssr/index.js': code } }), http = await f.listen();
  const before = await readFile(join(f.controller.dir, 'state.json'), 'utf8');
  assert.equal((await http.get(`/v1/deployments/${request.id}/review`, null)).status, 401);
  const credential = await f.controller.issueCredential('deploy', ['demo']);
  assert.equal((await http.get(`/v1/deployments/${request.id}/review`, `Bearer ${credential.token}`)).status, 401);
  const report = await selected(http, request);
  assert.equal(report.active, null); assert.equal(report.proposed.digest, request.digest);
  assert.ok(report.comparison.files.every(file => file.change === 'added'));
  assert.equal(report.state.runtimeReadiness, 'not-assessed'); assert.equal(report.state.applicationOutcome, 'not-assessed');
  const preview = await (await http.get(fileUrl(request, report.review, 'worker/index.js'))).text();
  assert.ok(preview.includes('&lt;/pre&gt;&lt;script&gt;window.reviewPwned=true&lt;/script&gt;'));
  assert.ok(!preview.includes('<script>window.reviewPwned')); assert.equal(globalThis.reviewMustNeverRun, undefined);
  assert.deepEqual(f.effects, []); assert.equal(await readFile(join(f.controller.dir, 'state.json'), 'utf8'), before);
  const home = await (await http.get('/')).text(); assert.ok(home.includes(`/admin/review/${request.id}`));
  assert.ok(!home.includes('data-action="approve"'));
});

test('comparison reports added, removed and changed files and SQL against the actual active release', async t => {
  const f = await decisionFixture(t), config = { assets: { directory: '../client' }, d1_databases: [{ binding: 'DB' }] };
  const initial = await f.submit('demo', { config, files: { 'dist/client/old.txt': 'old', 'dist/client/shared.txt': 'before', 'db/migrations/0001_initial.sql': 'CREATE TABLE example (id TEXT);' } });
  await f.controller.mutate(initial.id, initial.digest, 'approve');
  const request = await f.submit('demo', { config, files: { 'dist/client/new.txt': 'new', 'dist/client/shared.txt': 'after', 'db/migrations/0001_initial.sql': 'CREATE TABLE example (id TEXT);', 'db/migrations/0002_more.sql': 'CREATE TABLE extra (id TEXT);' } });
  const http = await f.listen(), report = await selected(http, request);
  assert.equal(report.active.id, initial.id); assert.equal(report.active.digest, initial.digest);
  assert.deepEqual(Object.fromEntries(report.comparison.files.map(file => [file.path, file.change])), {
    'assets/new.txt': 'added', 'assets/old.txt': 'removed', 'assets/shared.txt': 'changed', 'migrations/DB/0002_more.sql': 'added', 'worker/index.js': 'changed',
  });
  assert.deepEqual(report.comparison.migrationFiles, ['migrations/DB/0002_more.sql']);
  assert.equal(report.comparison.declarations.after.migrations.length, 2);
  const code = await (await http.get(fileUrl(request, report.review, 'assets/shared.txt'))).text();
  assert.match(code, /before/); assert.match(code, /after/);
});

for (const action of ['approve', 'reject']) test(`tampered proposed bytes refuse verified ${action} without effects or content disclosure`, async t => {
  const f = await decisionFixture(t), request = await f.submit(), http = await f.listen(), report = await selected(http, request);
  await writeFile(join(f.controller.artifact(request.id), 'worker/index.js'), 'private-corrupted-code');
  const response = await http.decide(request, action, { review: report.review });
  assert.equal(response.status, 409); assert.ok(!(await response.text()).includes('private-corrupted-code'));
  assert.equal(request.status, 'pending'); assert.deepEqual(f.effects, []);
  assert.equal(f.controller.state.decisions.at(-1).outcome, 'refused');
  const page = await http.get(`/admin/review/${request.id}`); assert.equal(page.status, 409); assert.ok(!(await page.text()).includes('private-corrupted-code'));
});

test('tampered active baseline blocks a guarded decision even when the proposed bytes are intact', async t => {
  const f = await decisionFixture(t), initial = await f.submit(); await f.controller.mutate(initial.id, initial.digest, 'approve');
  const request = await f.submit(), http = await f.listen(), report = await selected(http, request), effects = f.effects.length;
  await writeFile(join(f.controller.artifact(initial.id), 'worker/index.js'), 'private-baseline-tamper');
  assert.equal((await http.decide(request, 'approve', { review: report.review })).status, 409);
  assert.equal(f.effects.length, effects); assert.equal(request.status, 'pending');
});

test('linked, oversized and pruned artifacts cannot produce a verified comparison', async t => {
  const f = await decisionFixture(t), request = await f.submit(), http = await f.listen(), path = join(f.controller.artifact(request.id), 'worker/index.js');
  const original = await readFile(path), target = join(f.root, 'private-target.js'); await writeFile(target, 'private-linked-code');
  await unlink(path); await symlink(target, path);
  assert.equal((await http.get(`/v1/deployments/${request.id}/review`)).status, 409);
  await unlink(path); await writeFile(path, original); await truncate(path, MAX_UPLOAD + 1);
  assert.equal((await http.get(`/v1/deployments/${request.id}/review`)).status, 409);
  request.artifactPruned = { at: '2026-10-29T00:00:00Z' };
  assert.equal((await http.get(`/v1/deployments/${request.id}/review`)).status, 410);
  assert.deepEqual(f.effects, []);
});

test('file selection is bound to the review context and cannot traverse outside verified inventory', async t => {
  const f = await decisionFixture(t), request = await f.submit(), http = await f.listen(), report = await selected(http, request);
  assert.equal((await http.get(fileUrl(request, report.review, '../../private.env'))).status, 404);
  assert.equal((await http.get(fileUrl(request, report.review, 'worker/index.js', -1))).status, 400);
  assert.equal((await http.get(fileUrl(request, 'a'.repeat(64), 'worker/index.js'))).status, 409);
  request.status = 'superseded';
  assert.equal((await http.get(fileUrl(request, report.review, 'worker/index.js'))).status, 409);
});

test('required secrets stay private and review decisions bind the exact displayed revision', async t => {
  const f = await decisionFixture(t), request = await f.submit('demo', { config: { secrets: { required: ['API_KEY'] } } }), http = await f.listen();
  const missingPage = await (await http.get(`/admin/review/${request.id}`)).text(); assert.match(missingPage, /<button\b[^>]*data-action="approve"[^>]*\sdisabled>/);
  const first = await f.controller.replaceSecrets('demo', { API_KEY: 'private-operator-value' }), report = await selected(http, request);
  assert.equal(report.proposed.secretRevision, first.revision); assert.ok(!JSON.stringify(report).includes('private-operator-value'));
  const page = await (await http.get(`/admin/review/${request.id}`)).text(); assert.ok(page.includes(first.revision)); assert.ok(!page.includes('private-operator-value'));
  await f.controller.replaceSecrets('demo', { API_KEY: 'private-new-operator-value' });
  assert.equal((await http.decide(request, 'approve', { review: report.review, secretRevision: first.revision })).status, 409);
  assert.deepEqual(f.effects, []);
});

test('ordinary dashboard and review views withhold raw activation and quarantine diagnostics', async t => {
  const f = await decisionFixture(t), request = await f.submit(), http = await f.listen();
  f.onPublish(() => { throw Error('private-runtime-diagnostic'); }); await f.controller.mutate(request.id, request.digest, 'approve');
  f.controller.state.apps.demo.reason = 'private-quarantine-diagnostic';
  for (const path of ['/', `/admin/review/${request.id}`, `/v1/deployments/${request.id}/review`]) {
    const response = await http.get(path); assert.equal(response.status, 200); const text = await response.text();
    assert.ok(!text.includes('private-runtime-diagnostic')); assert.ok(!text.includes('private-quarantine-diagnostic'));
  }
});

test('large text and binary previews are bounded and retain Unicode boundary characters', async t => {
  const f = await decisionFixture(t), text = 'a'.repeat(65535) + '😀' + 'z'.repeat(50);
  const request = await f.submit('demo', { config: { assets: { directory: '../client' } }, files: { 'dist/client/large.txt': text, 'dist/client/binary.bin': Buffer.from([0, 255, 1, 2]) } }), http = await f.listen(), report = await selected(http, request);
  for (const offset of [0, 65536]) {
    const page = await (await http.get(fileUrl(request, report.review, 'assets/large.txt', offset))).text();
    assert.ok(page.includes('😀')); assert.ok(!page.includes('�')); assert.ok(page.length < 100000);
  }
  const binary = await (await http.get(fileUrl(request, report.review, 'assets/binary.bin'))).text(); assert.match(binary, /Binary file/);
});

test('recorded declaration tampering cannot override the canonical artifact identity shown in review', async t => {
  const f = await decisionFixture(t), request = await f.submit(), http = await f.listen();
  request.requiredSecrets = ['PRIVATE_REPLACEMENT'];
  const response = await http.get(`/v1/deployments/${request.id}/review`);
  assert.equal(response.status, 409); assert.ok(!(await response.text()).includes('PRIVATE_REPLACEMENT'));
  assert.deepEqual(f.effects, []);
});

test('an identical pending artifact still provides browser access to unchanged verified code', async t => {
  const f = await decisionFixture(t), files = { 'dist/ssr/index.js': 'export default {fetch(){return new Response("same")}}' };
  const active = await f.submit('demo', { files }); await f.controller.mutate(active.id, active.digest, 'approve');
  const request = await f.submit('demo', { files }), http = await f.listen(), report = await selected(http, request);
  assert.equal(request.digest, active.digest); assert.deepEqual(report.comparison.files, []);
  const page = await (await http.get(`/admin/review/${request.id}`)).text();
  assert.match(page, /All verified files, including unchanged/); assert.match(page, /worker\/index.js/);
  assert.equal((await http.get(fileUrl(request, report.review, 'worker/index.js'))).status, 200);
});

for (const action of ['approve', 'reject']) test(`guarded ${action} binds the requested secret revision to the displayed review`, async t => {
  const f = await decisionFixture(t), request = await f.submit('demo', { config: { secrets: { required: ['API_KEY'] } } }), http = await f.listen();
  await f.controller.replaceSecrets('demo', { API_KEY: 'private-operator-secret' });
  const report = await selected(http, request);
  const response = await http.decide(request, action, { review: report.review, secretRevision: '00000000-0000-4000-8000-000000000001' });
  assert.equal(response.status, 409); assert.equal(request.status, 'pending'); assert.deepEqual(f.effects, []);
  assert.equal(f.controller.state.decisions.at(-1).outcome, 'refused');
});
