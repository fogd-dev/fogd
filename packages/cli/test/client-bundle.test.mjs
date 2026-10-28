import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, chmod, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exportClientBundle } from '../src/client/bundle.mjs';
import { verifyClientFiles, verifyTransferFiles, transferFiles } from '../src/distribution/bootstrap.mjs';

const exec = promisify(execFile), cli = new URL('../bin/fogd.js', import.meta.url).pathname;
const id = '00000000-0000-4000-8000-000000000001';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-client-'));
  t.after(async () => { await chmod(join(root, 'client'), 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  const bundle = join(root, 'client'), exported = await exportClientBundle(bundle), calls = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    calls.push({ url: request.url, method: request.method, token: request.headers.authorization, body });
    response.setHeader('Content-Type', 'application/json');
    if (respond?.(request, response, body)) return;
    if (request.url.startsWith('/v1/capabilities')) response.end(JSON.stringify({ schema: 1, app: 'test-app', cronApps: false }));
    else if (request.method === 'POST') {
      const release = JSON.parse(body);
      response.end(JSON.stringify({ id, app: release.app, digest: release.digest, status: 'pending' }));
    } else response.end(JSON.stringify({ id, app: 'test-app', digest: 'a'.repeat(64), status: 'pending', step: 'submitted', submittedAt: null, private: 'private-server-data' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const home = join(root, 'state'), env = { PATH: '', HOME: root, FOGD_CLIENT_HOME: home,
    FOGD_SERVER: `http://127.0.0.1:${server.address().port}`, FOGD_DEPLOY_TOKEN: 'private-deploy-token',
    FOGD_HOME: join(root, 'operator-home'), FOGD_ADMIN_PASSWORD: 'private-admin-password', MINIO_ROOT_PASSWORD: 'private-storage-password', CLOUDFLARE_API_TOKEN: 'private-cloud-token' };
  return { root, bundle, home, env, exported, calls,
    run: (args, extra = {}, cwd = root) => exec(process.execPath, [join(bundle, 'fogd.mjs'), ...args], { env: { ...env, ...extra }, cwd, timeout: 20000 }) };
}
async function application(f) {
  const project = join(f.root, 'app'), vite = join(project, 'node_modules/vite');
  await mkdir(vite, { recursive: true });
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'test-app', type: 'module' }));
  await writeFile(join(vite, 'package.json'), JSON.stringify({ name: 'vite', type: 'module', main: 'index.mjs' }));
  // A tiny application-owned compiler exercises the client process boundary.
  // Native qualification separately uses the real cached Void/Vite toolchain.
  await writeFile(join(vite, 'index.mjs'), `import {mkdir,writeFile} from 'node:fs/promises';
export const createBuilder=async()=>({async buildApp(){
await writeFile('build-env.json',JSON.stringify(process.env));
await mkdir('dist/ssr',{recursive:true});
await writeFile('dist/ssr/index.js','export default {fetch(){return new Response("ok")}}');
await writeFile('dist/ssr/wrangler.json',JSON.stringify({main:'index.js'}));
}});`);
  return project;
}

test('image-free export and standalone verification need only Node and carry no operator state', async t => {
  const f = await fixture(t);
  const second = JSON.parse((await exec(process.execPath, [cli, 'client', 'export', join(f.root, 'second-client')], { env: { PATH: '' } })).stdout);
  assert.equal(second.manifestSha256, f.exported.manifestSha256);
  const metadata = JSON.parse(await readFile(join(f.bundle, 'manifest.json')));
  assert.equal(f.exported.bootstrapSha256, hash(await readFile(join(f.bundle, 'verify-client.mjs'))));
  assert.ok(f.exported.bytes < 1024 ** 2); assert.equal(f.exported.dockerContacted, false);
  assert.deepEqual((await transferFiles(f.bundle)).sort(), [...Object.keys(metadata.files), 'manifest.json'].sort());
  assert.ok(Object.keys(metadata.files).every(path => !/images\.tar|compose|\.env|catalog|backend|workerd|controller\.mjs/.test(path)));
  const verified = await exec(process.execPath, [join(f.bundle, 'verify-client.mjs'), f.bundle, f.exported.manifestSha256], { env: { PATH: '' } });
  assert.equal(JSON.parse(verified.stdout).dockerContacted, false);
  await assert.rejects(verifyTransferFiles(f.bundle, f.exported.manifestSha256), /Unsupported transfer inventory/);
  const ordinary = await exec(process.execPath, [cli, 'client', 'verify', f.bundle, '--expected-manifest', f.exported.manifestSha256], { env: { PATH: '' } });
  assert.equal(JSON.parse(ordinary.stdout).verifiedFiles, f.exported.files);
});
for (const [name, change, message] of [
  ['changed code', f => writeFile(join(f.bundle, 'fogd.mjs'), 'throw 1'), /checksum differs/],
  ['missing code', f => rm(join(f.bundle, 'fogd.mjs')), /missing or unexpected/],
  ['extra private file', f => writeFile(join(f.bundle, '.env'), 'private'), /missing or unexpected/],
  ['empty extra directory', f => mkdir(join(f.bundle, 'unexpected')), /Empty directories/],
  ['linked code', async f => { await rm(join(f.bundle, 'fogd.mjs')); await symlink('/dev/null', join(f.bundle, 'fogd.mjs')); }, /without symlinks/],
]) test(`verification rejects ${name}`, async t => {
  const f = await fixture(t); await change(f);
  await assert.rejects(verifyClientFiles(f.bundle, f.exported.manifestSha256), message);
});
test('wrong hash, wrong format and independently hashed private program member are refused', async t => {
  const f = await fixture(t), path = join(f.bundle, 'manifest.json'), metadata = JSON.parse(await readFile(path));
  await assert.rejects(verifyClientFiles(f.bundle, '0'.repeat(64)), /manifest checksum differs/);
  metadata.format = 'fogd-runtime-transfer-v1'; let text = JSON.stringify(metadata, null, 2) + '\n';
  await writeFile(path, text); await assert.rejects(verifyClientFiles(f.bundle, hash(text)), /Unsupported transfer inventory/);
  metadata.format = 'fogd-client-bundle-v1'; metadata.files['program/.env'] = { bytes: 0, sha256: hash('') };
  await writeFile(join(f.bundle, 'program/.env'), ''); text = JSON.stringify(metadata, null, 2) + '\n';
  await writeFile(path, text); await assert.rejects(verifyClientFiles(f.bundle, hash(text)), /Invalid developer client inventory/);
});
test('existing destination remains unchanged on repeated export', async t => {
  const f = await fixture(t), before = await readFile(join(f.bundle, 'manifest.json'));
  await assert.rejects(exportClientBundle(f.bundle), { code: 'EEXIST' });
  assert.deepEqual(await readFile(join(f.bundle, 'manifest.json')), before);
});
test('copied read-only client reads scoped status without creating any state directory', async t => {
  const f = await fixture(t);
  for (const path of await transferFiles(f.bundle)) await chmod(join(f.bundle, path), 0o400);
  await chmod(f.bundle, 0o500);
  const result = await f.run(['status', id]);
  assert.equal(JSON.parse(result.stdout).id, id); assert.equal(result.stdout.includes('private-'), false);
  assert.deepEqual(f.calls.map(({ url, method, token }) => ({ url, method, token })), [{ url: `/v1/deployments/${id}`, method: 'GET', token: 'Bearer private-deploy-token' }]);
  await assert.rejects(access(f.home), { code: 'ENOENT' });
  await assert.rejects(access(f.env.FOGD_HOME), { code: 'ENOENT' });
});
for (const credentials of ['absent', 'configured']) test(`standalone offline doctor with ${credentials} credentials needs no build toolchain, Docker or state writes`, async t => {
  const f = await fixture(t), config = join(f.root, 'config.json');
  await writeFile(config, JSON.stringify({ triggers: { crons: ['* * * * *'] }, vars: { MESSAGE: 'private-variable' } }));
  for (const path of await transferFiles(f.bundle)) await chmod(join(f.bundle, path), 0o400);
  await chmod(f.bundle, 0o500);
  const env = credentials === 'absent' ? { FOGD_SERVER: '', FOGD_DEPLOY_TOKEN: '' } : {};
  await assert.rejects(f.run(['doctor', '--config', config, '--name', 'test-app', '--json'], env), error => {
    assert.equal(error.code, 2);
    const report = JSON.parse(error.stdout);
    assert.equal(report.capabilitySource, 'offline');
    assert.equal(report.declarations.cronExpressions, 1);
    assert.ok(!error.stdout.includes('private-')); assert.equal(error.stderr, '');
    return true;
  });
  assert.deepEqual(f.calls, []);
  await assert.rejects(access(f.home), { code: 'ENOENT' });
  await assert.rejects(access(f.env.FOGD_HOME), { code: 'ENOENT' });
});
for (const [name, status, body, headers] of [
  ['malformed capability', 200, 'private-capability-json', {}],
  ['credential refusal', 403, 'private-rejection', {}],
  ['redirect', 307, '', { Location: '/private-destination' }],
]) test(`standalone doctor keeps admission unverified after ${name}`, async t => {
  const f = await fixture(t, (_, response) => { response.writeHead(status, headers); response.end(body); return true; });
  const config = join(f.root, 'config.json');
  await writeFile(config, JSON.stringify({ triggers: { crons: ['* * * * *'] } }));
  await assert.rejects(f.run(['doctor', '--config', config, '--name', 'test-app', '--online', '--json']), error => {
    assert.equal(error.code, 2);
    const report = JSON.parse(error.stdout);
    assert.equal(report.capabilitySource, 'unavailable');
    assert.equal(report.findings.find(item => item.id === 'cron-admission').status, 'unverified');
    assert.ok(!error.stdout.includes('private-')); assert.equal(error.stderr, '');
    return true;
  });
  assert.deepEqual(f.calls.map(({ method, url }) => ({ method, url })), [{ method: 'GET', url: '/v1/capabilities?app=test-app' }]);
  await assert.rejects(access(f.home), { code: 'ENOENT' });
});
for (const [allowed, exit] of [[false, 1], [true, 2]]) test(`standalone online doctor observes cron admission ${allowed} using a scoped GET only`, async t => {
  const f = await fixture(t, (_, response) => { response.end(JSON.stringify({ schema: 1, app: 'test-app', cronApps: allowed })); return true; });
  const config = join(f.root, 'config.json');
  await writeFile(config, JSON.stringify({ triggers: { crons: ['* * * * *'] } }));
  await assert.rejects(f.run(['doctor', '--config', config, '--name', 'test-app', '--online', '--json']), error => {
    assert.equal(error.code, exit);
    const report = JSON.parse(error.stdout);
    assert.equal(report.capabilitySource, 'controller');
    assert.ok(!error.stdout.includes('private-')); assert.equal(error.stderr, '');
    return true;
  });
  assert.deepEqual(f.calls.map(({ url, method, token }) => ({ url, method, token })), [{ url: '/v1/capabilities?app=test-app', method: 'GET', token: 'Bearer private-deploy-token' }]);
  await assert.rejects(access(f.home), { code: 'ENOENT' });
});
for (const args of [['up'], ['admin', 'list'], ['deploy', 'extra'], ['deploy', '--name'], ['status'], ['status', '../escape']]) test(`invalid client command refuses before state or network: ${args.join(' ')}`, async t => {
  const f = await fixture(t); await assert.rejects(f.run(args), { code: 1 });
  assert.deepEqual(f.calls, []); await assert.rejects(access(f.home), { code: 'ENOENT' });
});
for (const extra of [{ FOGD_SERVER: '' }, { FOGD_DEPLOY_TOKEN: '' }, { FOGD_SERVER: 'http://private-user:private-password@127.0.0.1' }]) test('missing credentials or credential-bearing endpoints refuse before creating state', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run(['deploy'], extra), error => error.code === 1 && !error.stderr.includes('private-'));
  assert.deepEqual(f.calls, []); await assert.rejects(access(f.home), { code: 'ENOENT' });
});
test('client builds outside checkout, strips infrastructure credentials, and retains a pending-only submission receipt in user state', async t => {
  const f = await fixture(t), project = await application(f);
  const result = JSON.parse((await f.run(['deploy'], {}, project)).stdout);
  assert.equal(result.id, id); assert.equal(result.status, 'pending');
  assert.deepEqual(f.calls.map(call => [call.method, call.url]), [['GET', '/v1/capabilities?app=test-app'], ['POST', '/v1/deployments']]);
  assert.ok(f.calls.every(call => call.token === 'Bearer private-deploy-token'));
  const buildEnv = JSON.parse(await readFile(join(project, 'build-env.json')));
  assert.equal(buildEnv.VOID_REMOTE, '0'); assert.equal(buildEnv.WRANGLER_SEND_METRICS, 'false');
  assert.ok(!JSON.stringify(buildEnv).includes('private-'));
  assert.equal(Object.hasOwn(buildEnv, 'FOGD_HOME'), false);
  assert.equal(Object.hasOwn(buildEnv, 'FOGD_CLIENT_HOME'), false);
  const builds = join(f.home, '.fogd/build-cache/test-app');
  assert.deepEqual(await readdir(builds), [result.localBuildId]);
  const record = JSON.parse(await readFile(join(builds, result.localBuildId, 'record.json')));
  assert.equal(record.phase, 'submitted'); assert.equal(record.submission, id); assert.equal(record.digest, result.digest);
  assert.ok(!f.calls[1].body.includes('private-'));
  await assert.rejects(access(f.env.FOGD_HOME), { code: 'ENOENT' });
});
for (const [name, code, body] of [['private rejection', 400, 'private-controller-error'], ['oversized receipt', 200, 'private-' + 'x'.repeat(65536)], ['broken receipt', 200, 'private-json']]) test(`${name} keeps uncertain local output and withholds response contents`, async t => {
  const f = await fixture(t, (request, response) => { if (request.method !== 'POST') return false; response.statusCode = code; response.end(body); return true; });
  const project = await application(f);
  await assert.rejects(f.run(['deploy'], {}, project), error => error.code === 1 && !error.stderr.includes('private-'));
  const parent = join(f.home, '.fogd/build-cache/test-app'), [build] = await readdir(parent);
  assert.equal(JSON.parse(await readFile(join(parent, build, 'record.json'))).phase, 'uncertain');
  await access(join(parent, build, 'artifact/worker/index.js'));
});
test('submission redirects do not follow the token and retain uncertain local state', async t => {
  const f = await fixture(t, (request, response) => { if (request.method !== 'POST') return false; response.writeHead(307, { Location: '/private-admin' }); response.end(); return true; });
  await assert.rejects(f.run(['deploy'], {}, await application(f)), /Submission transport failed/);
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(call => call.url !== '/private-admin'));
});
test('explicit profile supplies scoped configuration while process values take precedence', async t => {
  const f = await fixture(t), profile = join(f.root, 'developer.env');
  await writeFile(profile, `FOGD_SERVER=${f.env.FOGD_SERVER}\nFOGD_DEPLOY_TOKEN=private-file-token\n`);
  await f.run(['status', id], { FOGD_ENV_FILE: profile });
  assert.equal(f.calls[0].token, 'Bearer private-deploy-token');
  const { FOGD_SERVER, FOGD_DEPLOY_TOKEN, ...withoutConfig } = f.env;
  await exec(process.execPath, [join(f.bundle, 'fogd.mjs'), 'status', id], { env: { ...withoutConfig, FOGD_ENV_FILE: profile }, cwd: f.root });
  assert.equal(f.calls[1].token, 'Bearer private-file-token');
});
test('default XDG state location supports deployment without FOGD_HOME or FOGD_CLIENT_HOME', async t => {
  const f = await fixture(t), project = await application(f);
  const { FOGD_HOME, FOGD_CLIENT_HOME, ...env } = f.env, state = join(f.root, 'xdg-state');
  const output = await exec(process.execPath, [join(f.bundle, 'fogd.mjs'), 'deploy'], { env: { ...env, XDG_STATE_HOME: state }, cwd: project });
  const report = JSON.parse(output.stdout);
  await access(join(state, 'fogd-client/.fogd/build-cache/test-app', report.localBuildId, 'record.json'));
  await assert.rejects(access(f.home), { code: 'ENOENT' });
});
