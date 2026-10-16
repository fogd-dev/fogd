// Exercises a fresh stack. --existing uses already-pending CLI submissions.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { configEnv, stackRoot, run, compose } from '../packages/cli/src/local.mjs';
import { request } from './http.mjs';

const env = await configEnv();
const admin = env.FOGD_SERVER || `http://127.0.0.1:${env.FOGD_ADMIN_PORT || 8788}`;
const publicURL = env.FOGD_URL || `http://127.0.0.1:${env.FOGD_HTTP_PORT || 8787}`;
const basic = `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER || 'admin'}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`;
const bearer = `Bearer ${env.FOGD_DEPLOY_TOKEN}`;
async function api(path, method = 'GET', body, auth = basic, headers = {}) {
  const response = await fetch(admin + path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(900000) });
  return { status: response.status, body: await response.json() };
}
async function mutate(d, action, digest = d.digest) {
  const { body: { csrf } } = await api('/v1/admin');
  return api(`/v1/deployments/${d.id}/${action}`, 'POST', { digest }, basic, { 'X-Fogd-CSRF': csrf });
}
const appRequest = (app, path, options = {}) => request(publicURL + path, { ...options, headers: { Host: `${app}.${env.FOGD_BASE_DOMAIN || 'localhost'}`, 'Content-Type': 'application/json' } });
async function eventually(fn) {
  let error;
  for (let i = 0; i < 60; i++) {
    try { return await fn(); } catch (e) { error = e; await new Promise(r => setTimeout(r, 1000)); }
  }
  throw error;
}
if (!process.argv.includes('--existing')) {
  for (const app of ['hello', 'notebook']) await run(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), 'deploy'], { cwd: join(stackRoot, 'examples', app), env });
}
const state = (await api('/v1/admin')).body;
const pending = app => Object.values(state.deployments).find(d => d.app === app && d.status === 'pending');
let hello = pending('hello'); const notebook = pending('notebook');
assert.ok(hello && notebook, 'Two CLI submissions required');
assert.equal((await appRequest('hello', '/api/posts')).status, 404);
assert.equal((await appRequest('notebook', '/api/entries')).status, 404);
assert.equal((await api('/v1/admin', 'GET', null, bearer)).status, 401);
assert.equal((await api(`/v1/deployments/${hello.id}/approve`, 'POST', { digest: hello.digest }, bearer)).status, 401);
assert.equal((await mutate(hello, 'approve', '0'.repeat(64))).status, 400);
const helloArtifact = (await api(`/v1/deployments/${hello.id}/artifact`)).body;
assert.equal((await mutate(hello, 'reject')).body.status, 'rejected');
assert.equal((await appRequest('hello', '/api/posts')).status, 404);
const invalid = structuredClone(helloArtifact); invalid.files.push({ path: 'fogd-release.json', data: 'e30=' });
assert.equal((await api('/v1/deployments', 'POST', invalid, bearer)).status, 400);
hello = (await api('/v1/deployments', 'POST', helloArtifact, bearer)).body;
for (const d of [hello, notebook]) {
  console.log(`Approving ${d.app} ${d.digest}`);
  const result = await mutate(d, 'approve');
  assert.equal(result.body.status, 'active', JSON.stringify(result));
  console.log(`${d.app}: active at ${result.body.version}`);
}
assert.deepEqual(await (await appRequest('hello', '/api/posts')).json(), []);
assert.equal((await appRequest('notebook', '/api/entries')).status, 200);
assert.equal((await appRequest('unknown', '/')).status, 404);
assert.equal((await appRequest('hello', '/__void/migrate', { method: 'POST' })).status, 404);
const entry = { id: `platform-${Date.now()}`, title: 'Approved deploy', body: 'D1 + R2 + Durable Object' };
assert.equal((await appRequest('notebook', '/api/entries', { method: 'PUT', body: JSON.stringify(entry) })).status, 200);
const original = (await api(`/v1/deployments/${notebook.id}/artifact`)).body;
const broken = structuredClone(original);
broken.files.push({ path: 'migrations/DB/9999_failure.sql', data: Buffer.from('THIS IS INVALID SQL;').toString('base64') });
const hash = createHash('sha256');
for (const file of [...broken.files].sort((a, b) => a.path < b.path ? -1 : 1)) { const bytes = Buffer.from(file.data, 'base64'); hash.update(JSON.stringify([file.path, bytes.length])); hash.update(bytes); }
broken.digest = hash.digest('hex');
const failed = (await api('/v1/deployments', 'POST', broken, bearer)).body;
assert.equal((await mutate(failed, 'approve')).body.status, 'failed');
assert.equal((await appRequest('notebook', '/api/entries')).status, 503);
assert.equal((await appRequest('hello', '/api/posts')).status, 200);
const repaired = (await api('/v1/deployments', 'POST', original, bearer)).body;
assert.equal((await mutate(repaired, 'approve')).body.status, 'active');
console.log('Failed SQL activation paused only its app; corrected submission recovered');
await compose(['restart', 'controller', 'workerd'], env);
await eventually(async () => {
  const response = await appRequest('notebook', '/api/entries'); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).entries.find(row => row.id === entry.id), entry);
  assert.equal((await appRequest('hello', '/api/posts')).status, 200);
});
console.log('PASS: CLI submissions, rejection, exact approval, auth, two hosts, SQL failure recovery, D1/R2/DO and controller/workerd restart');
