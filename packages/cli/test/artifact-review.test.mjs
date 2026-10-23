import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, access, rm, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), cli = new URL('../bin/fogd.js', import.meta.url).pathname;
const oldId = '00000000-0000-4000-8000-000000000001', id = '00000000-0000-4000-8000-000000000002', credential = '00000000-0000-4000-8000-000000000003';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function artifact(updated) {
  const config = { name: 'review-app', main: 'worker/index.js', compatibility_flags: [], no_bundle: true, vars: {},
    durable_objects: { bindings: [] }, migrations: [], d1_databases: [{ binding: 'DB', database_name: 'review-app-db', database_id: 'review-app-db', migrations_dir: 'migrations/DB' }],
    r2_buckets: updated ? [{ binding: 'FILES', bucket_name: 'review-app-files' }] : [] };
  const files = { 'wrangler.json': JSON.stringify(config), 'worker/index.js': `throw new Error('must not execute ${updated ? 'new' : 'old'} application code');`,
    'migrations/DB/0001_create.sql': 'CREATE TABLE messages(id INTEGER PRIMARY KEY, text TEXT);',
    [updated ? 'assets/new.txt' : 'assets/old.txt']: updated ? 'new asset' : 'old asset' };
  if (updated) files['migrations/DB/0002_label.sql'] = 'ALTER TABLE messages ADD COLUMN label TEXT;';
  const digest = createHash('sha256');
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    digest.update(JSON.stringify([path, Buffer.byteLength(text)])); digest.update(text);
  }
  return { app: 'review-app', digest: digest.digest('hex'), files: Object.entries(files).map(([path, text]) => ({ path, data: Buffer.from(text).toString('base64') })) };
}
async function fixture(t, respond) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fogd-review-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const before = artifact(false), after = artifact(true), calls = [], output = join(root, 'review');
  const release = (id, digest, status) => ({ id, app: 'review-app', digest, status, step: status === 'active' ? 'complete' : 'submitted', submittedAt: '2026-10-22T12:00:00.000Z', submitter: credential,
    error: 'private-runtime-error', version: 'private-runtime-version', private: 'private-field' });
  const state = { csrf: 'private-csrf', secrets: { token: 'private-secret-value' },
    credentials: [{ id: credential, name: 'Review builder', revokedAt: null, hash: 'private-credential-hash' }],
    deployments: { [oldId]: release(oldId, before.digest, 'active'), [id]: release(id, after.digest, 'pending') },
    apps: { 'review-app': { active: oldId, route: 'active', version: 'private-materialized-version' } } };
  const server = createServer((request, response) => {
    calls.push({ path: request.url, method: request.method, authorization: request.headers.authorization });
    response.setHeader('Content-Type', 'application/json');
    if (respond?.({ request, response, state, before, after, calls })) return;
    const body = request.url === '/v1/admin' ? state : request.url === `/v1/deployments/${id}/artifact` ? after : before;
    response.end(JSON.stringify(body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { PATH: '', HOME: root, FOGD_HOME: root, FOGD_ENV_FILE: join(root, 'absent.env'), FOGD_SERVER: `http://127.0.0.1:${server.address().port}`, FOGD_ADMIN_USER: 'owner', FOGD_ADMIN_PASSWORD: 'private-admin-password', FOGD_DEPLOY_TOKEN: 'private-deploy-token' };
  return { root, output, before, after, calls, state, env,
    run: (args = [id, '--output', output], extra = {}) => exec(process.execPath, [cli, 'admin', 'review', ...args], { env: { ...env, ...extra }, timeout: 20000 }) };
}
test('review exports verified readable before/after artifacts and an exact change list using only administrator GETs', async t => {
  const f = await fixture(t), result = await f.run(), report = JSON.parse(result.stdout);
  assert.deepEqual(report.comparison.files.map(({ path, change }) => ({ path, change })), [
    { path: 'assets/new.txt', change: 'added' }, { path: 'assets/old.txt', change: 'removed' }, { path: 'migrations/DB/0002_label.sql', change: 'added' }, { path: 'worker/index.js', change: 'changed' }, { path: 'wrangler.json', change: 'changed' },
  ]);
  assert.equal(report.comparison.unchangedFiles, 1); assert.deepEqual(report.comparison.migrationFiles, ['migrations/DB/0002_label.sql']);
  assert.equal(report.proposed.digest, f.after.digest); assert.deepEqual(report.active, { id: oldId, digest: f.before.digest });
  assert.deepEqual(report.proposed.submitter, { id: credential, name: 'Review builder', revoked: false });
  assert.deepEqual(report.comparison.declarations.before.resources.r2, []);
  assert.deepEqual(report.comparison.declarations.after.resources.r2, [{ binding: 'FILES', bucket_name: 'review-app-files' }]);
  assert.deepEqual(report.comparison.changedDeclarations.resources, ['r2']);
  assert.deepEqual(report.comparison.changedDeclarations.requiredSecrets, { added: [], removed: [] });
  assert.equal(await readFile(join(f.output, 'proposed/migrations/DB/0002_label.sql'), 'utf8'), 'ALTER TABLE messages ADD COLUMN label TEXT;');
  assert.equal(await readFile(join(f.output, 'active/assets/old.txt'), 'utf8'), 'old asset');
  assert.equal(report.comparison.files.find(file => file.path === 'worker/index.js').after.sha256, hash("throw new Error('must not execute new application code');"));
  const { directory, ...saved } = report; assert.equal(directory, f.output); assert.deepEqual(JSON.parse(await readFile(join(f.output, 'review.json'))), saved);
  assert.equal((await stat(f.output)).mode & 0o777, 0o700); assert.equal((await stat(join(f.output, 'review.json'))).mode & 0o777, 0o600);
  assert.equal(result.stdout.includes('private-'), false); assert.equal(result.stderr, '');
  assert.deepEqual(f.calls.map(call => call.path), ['/v1/admin', `/v1/deployments/${id}/artifact`, `/v1/deployments/${oldId}/artifact`, '/v1/admin']);
  assert.ok(f.calls.every(call => call.method === 'GET' && call.authorization === `Basic ${Buffer.from('owner:private-admin-password').toString('base64')}`));
});
test('first release has no baseline and every proposed file is added', async t => {
  const f = await fixture(t); delete f.state.apps['review-app'];
  const report = JSON.parse((await f.run()).stdout);
  assert.equal(report.active, null); assert.equal(report.directories.active, null); assert.equal(report.comparison.files.length, 5);
  assert.ok(report.comparison.files.every(file => file.change === 'added')); assert.equal(f.calls.length, 3);
});
for (const args of [[], ['invalid', '--output', 'x'], [id], [id, '--output', '']]) test(`invalid review arguments refuse before HTTP: ${JSON.stringify(args)}`, async t => {
  const f = await fixture(t); await assert.rejects(f.run(args), /Usage:/); assert.deepEqual(f.calls, []);
});
test('deploy credentials never replace administrator authentication', async t => {
  const f = await fixture(t); await assert.rejects(f.run(undefined, { FOGD_ADMIN_PASSWORD: '' }), /Set FOGD_ADMIN_PASSWORD/);
  assert.deepEqual(f.calls, []); await assert.rejects(access(f.output), { code: 'ENOENT' });
});
test('existing output is retained unchanged before network access', async t => {
  const f = await fixture(t); await writeFile(f.output, 'retained operator data');
  await assert.rejects(f.run(), /output already exists/); assert.deepEqual(f.calls, []); assert.equal(await readFile(f.output, 'utf8'), 'retained operator data');
});
for (const [name, change, message] of [
  ['wrong app', data => ({ ...data, app: 'other-app' }), /differs/],
  ['wrong digest', data => ({ ...data, digest: 'a'.repeat(64) }), /differs/],
  ['changed bytes', data => ({ ...data, files: data.files.map(file => file.path === 'worker/index.js' ? { ...file, data: Buffer.from('changed').toString('base64') } : file) }), /failed validation/],
  ['traversal path', data => ({ ...data, files: [{ path: '../private-escape', data: '' }, ...data.files] }), /failed validation/],
  ['duplicate path', data => ({ ...data, files: [...data.files, data.files[0]] }), /failed validation/],
  ['noncanonical base64', data => ({ ...data, files: [{ ...data.files[0], data: 'invalid-private-value' }, ...data.files.slice(1)] }), /failed validation/],
]) test(`artifact ${name} refuses without a completed review or private diagnostics`, async t => {
  const f = await fixture(t, ({ request, response, after }) => { if (request.url !== `/v1/deployments/${id}/artifact`) return false; response.end(JSON.stringify(change(after))); return true; });
  await assert.rejects(f.run(), error => error.code === 1 && message.test(error.stderr) && !error.stderr.includes('private-'));
  await assert.rejects(access(join(f.output, 'review.json')), { code: 'ENOENT' });
  await assert.rejects(access(join(f.root, 'private-escape')), { code: 'ENOENT' });
});
for (const [name, respond, message] of [
  ['private HTTP failure', response => { response.statusCode = 500; response.end('private-controller-error'); }, /HTTP 500/],
  ['redirect', response => { response.writeHead(307, { Location: '/private-target' }); response.end(); }, /Cannot download/],
  ['wrong media type', response => { response.setHeader('Content-Type', 'text/html'); response.end('private-html'); }, /JSON artifact/],
  ['broken JSON', response => response.end('private-invalid-json'), /unreadable/],
]) test(`${name} refuses and never publishes review.json`, async t => {
  const f = await fixture(t, ({ request, response }) => { if (request.url === '/v1/admin') return false; respond(response); return true; });
  await assert.rejects(f.run(), error => error.code === 1 && message.test(error.stderr) && !error.stderr.includes('private-'));
  await assert.rejects(access(join(f.output, 'review.json')), { code: 'ENOENT' }); assert.equal(f.calls.length, 2);
});
test('changed app state during download retains copies but refuses a completed comparison', async t => {
  const f = await fixture(t, ({ request, state, calls }) => { if (request.url === '/v1/admin' && calls.length > 1) state.apps['review-app'].route = 'paused'; return false; });
  await assert.rejects(f.run(), /state changed during review/);
  await access(join(f.output, 'proposed/worker/index.js')); await assert.rejects(access(join(f.output, 'review.json')), { code: 'ENOENT' });
});
test('private diagnostic changes participate in the stability check without appearing in output', async t => {
  const f = await fixture(t, ({ request, state, calls }) => { if (request.url === '/v1/admin' && calls.length > 1) state.deployments[id].error = 'private-changed-error'; return false; });
  await assert.rejects(f.run(), error => /state changed/.test(error.stderr) && !error.stderr.includes('private-'));
  await assert.rejects(access(join(f.output, 'review.json')), { code: 'ENOENT' });
});
test('a valid JSON artifact above the transport limit refuses before publishing review.json', async t => {
  const f = await fixture(t, ({ request, response, after }) => {
    if (request.url !== `/v1/deployments/${id}/artifact`) return false;
    response.end(JSON.stringify({ ...after, padding: 'x'.repeat(64 * 1024 ** 2) })); return true;
  });
  await assert.rejects(f.run(), error => error.code === 1 && /oversized review artifact/.test(error.stderr));
  await assert.rejects(access(join(f.output, 'review.json')), { code: 'ENOENT' });
});
test('an active pointer into another app refuses before downloading any artifact', async t => {
  const f = await fixture(t); f.state.deployments[oldId].app = 'other-app';
  await assert.rejects(f.run(), /unavailable or different-app release/);
  assert.equal(f.calls.length, 1); await assert.rejects(access(f.output), { code: 'ENOENT' });
});
test('a failing active-artifact download retains the proposed copy without a completed review', async t => {
  const f = await fixture(t, ({ request, response }) => {
    if (request.url !== `/v1/deployments/${oldId}/artifact`) return false;
    response.statusCode = 404; response.end('private-baseline-error'); return true;
  });
  await assert.rejects(f.run(), error => /HTTP 404/.test(error.stderr) && !error.stderr.includes('private-'));
  await access(join(f.output, 'proposed/worker/index.js')); await assert.rejects(access(join(f.output, 'review.json')), { code: 'ENOENT' });
  assert.equal(f.calls.length, 3);
});
test('tampered active-artifact bytes cannot become a trusted review baseline', async t => {
  const f = await fixture(t, ({ request, response, before }) => {
    if (request.url !== `/v1/deployments/${oldId}/artifact`) return false;
    response.end(JSON.stringify({ ...before, files: before.files.map(file => file.path === 'worker/index.js' ? { ...file, data: Buffer.from('private-corrupt-baseline').toString('base64') } : file) })); return true;
  });
  await assert.rejects(f.run(), error => /failed validation/.test(error.stderr) && !error.stderr.includes('private-'));
  await access(join(f.output, 'proposed/worker/index.js')); await assert.rejects(access(join(f.output, 'review.json')), { code: 'ENOENT' });
});
