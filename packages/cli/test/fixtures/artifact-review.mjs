import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile), cli = new URL('../../bin/fogd.js', import.meta.url).pathname;
export const oldId = '00000000-0000-4000-8000-000000000001', id = '00000000-0000-4000-8000-000000000002', credential = '00000000-0000-4000-8000-000000000003';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function artifact(updated, extraConfig = {}) {
  const config = { name: 'review-app', main: 'worker/index.js', compatibility_flags: [], no_bundle: true, vars: {},
    durable_objects: { bindings: [] }, migrations: [], d1_databases: [{ binding: 'DB', database_name: 'review-app-db', database_id: 'review-app-db', migrations_dir: 'migrations/DB' }],
    r2_buckets: updated ? [{ binding: 'FILES', bucket_name: 'review-app-files' }] : [], ...extraConfig };
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
export async function reviewFixture(t, respond, command = ['admin', 'review']) {
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
    run: (args = [id, '--output', output], extra = {}) => exec(process.execPath, [cli, ...command, ...args], { env: { ...env, ...extra }, timeout: 20000 }) };
}
