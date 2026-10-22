import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prebootFixture } from './fixtures/cron-preboot.mjs';
import { freshRuntimePlan } from '../src/runtime/selection-plan.mjs';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';

const exec = promisify(execFile), cli = new URL('../bin/fogd.js', import.meta.url).pathname;
const bootstrap = new URL('../src/bootstrap.mjs', import.meta.url).href;
async function fixture(t, settings = '') {
  const root = await mkdtemp(join(tmpdir(), 'fogd-shared-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'), file = join(root, 'operator.env'), log = join(root, 'docker-calls');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FOGD_TEST_DOCKER_LOG"\nexit 87\n', { mode: 0o700 });
  await writeFile(file, settings, { mode: 0o600 });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, FOGD_HOME: root, FOGD_ENV_FILE: file, FOGD_TEST_DOCKER_LOG: log };
  return { root, bin, file, log, env };
}

for (const [name, settings] of [
  ['missing account', 'FOGD_BUCKET_PASSWORD=operator-private-password\n'],
  ['missing password', 'FOGD_BUCKET_USER=operator\n'],
  ['empty password', 'FOGD_BUCKET_USER=operator\nFOGD_BUCKET_PASSWORD=\n'],
  ['development password', 'FOGD_BUCKET_USER=fogd-local\nFOGD_BUCKET_PASSWORD=fogd-local-development-only\n'],
]) test(`shared startup refuses ${name} before writes or Docker`, async t => {
  const f = await fixture(t, settings);
  await assert.rejects(exec(process.execPath, [cli, 'up', '--shared'], { env: f.env, timeout: 10000 }), error =>
    error.code === 1 && /Shared storage requires/.test(error.stderr) && !error.stderr.includes('operator-private-password'));
  assert.equal(await readFile(f.file, 'utf8'), settings);
  await assert.rejects(access(f.log), { code: 'ENOENT' });
});

test('an existing shared profile refuses development storage without changing its environment', async t => {
  const settings = 'FOGD_PROFILE=shared\nFOGD_BUCKET_USER=fogd-local\nFOGD_BUCKET_PASSWORD=fogd-local-development-only\n';
  const f = await fixture(t, settings);
  await assert.rejects(exec(process.execPath, [cli, 'up'], { env: f.env, timeout: 10000 }), error =>
    error.code === 1 && /deliberate maintenance/.test(error.stderr) && !error.stderr.includes('fogd-local-development-only'));
  assert.equal(await readFile(f.file, 'utf8'), settings);
  await assert.rejects(access(f.log), { code: 'ENOENT' });
});

test('explicit shared storage reaches Docker without rewriting the storage credentials', async t => {
  const settings = 'FOGD_BUCKET_USER=operator\nFOGD_BUCKET_PASSWORD=operator-private-password\n';
  const f = await fixture(t, settings);
  await assert.rejects(exec(process.execPath, [cli, 'up', '--shared'], { env: f.env, timeout: 10000 }), error => error.code === 1 && /docker command failed \(87\)/.test(error.stderr));
  assert.match(await readFile(f.log, 'utf8'), /^compose .*config --format json\n$/);
  const saved = await readFile(f.file, 'utf8');
  assert.ok(saved.startsWith(settings));
  assert.equal(saved.match(/FOGD_BUCKET_PASSWORD=/g).length, 1);
  assert.match(saved, /FOGD_PROFILE=shared/);
  assert.equal((await stat(f.file)).mode & 0o777, 0o600);
});

test('repeated shared bootstrap preserves configured credentials and private file bytes', async t => {
  const settings = 'FOGD_PROFILE=shared\nFOGD_TLS=1\nFOGD_DEPLOY_TOKEN=\nFOGD_ADMIN_PASSWORD=private-admin\nFOGD_GATEWAY_TOKEN=private-gateway\nFOGD_BUCKET_USER=operator\nFOGD_BUCKET_PASSWORD=operator-private-password\n';
  const f = await fixture(t, settings);
  const result = await exec(process.execPath, ['--input-type=module', '-e', `import {prepareEnvironment} from ${JSON.stringify(bootstrap)}; await prepareEnvironment(); await prepareEnvironment(true);`], { env: f.env, timeout: 10000 });
  assert.equal(result.stdout, '');
  assert.equal(await readFile(f.file, 'utf8'), settings);
  await assert.rejects(access(f.log), { code: 'ENOENT' });
});

test('local bootstrap keeps the existing development storage behavior', async t => {
  const settings = 'FOGD_PROFILE=local\nFOGD_ADMIN_PASSWORD=private-admin\nFOGD_GATEWAY_TOKEN=private-gateway\nFOGD_DEPLOY_TOKEN=private-deploy\n';
  const f = await fixture(t, settings);
  await exec(process.execPath, ['--input-type=module', '-e', `import {prepareEnvironment} from ${JSON.stringify(bootstrap)}; await prepareEnvironment();`], { env: f.env, timeout: 10000 });
  assert.equal(await readFile(f.file, 'utf8'), settings);
  await assert.rejects(access(f.log), { code: 'ENOENT' });
});

test('enrolled shared startup refuses stored development credentials before Docker', async t => {
  const f = await fixture(t), { source } = prebootFixture();
  for (const [name, service] of Object.entries(source.services)) service.image = name === 'minio' ? 'fogd-minio:local' : 'fogd-runtime:local';
  const config = freshRuntimePlan(source, runtimeFamilies()[0]).config;
  Object.assign(config.services.controller.environment, { FOGD_PROFILE: 'shared', FOGD_TLS: '1', FOGD_DEPLOY_TOKEN: '', AWS_SECRET_ACCESS_KEY: 'fogd-local-development-only' });
  const directory = join(f.root, '.fogd/installations', config.name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'compose.json'), bytes = JSON.stringify(config);
  await writeFile(file, bytes, { mode: 0o600 });
  await assert.rejects(exec(process.execPath, [cli, 'up', '--installation', config.name], { env: f.env, timeout: 10000 }), error =>
    error.code === 1 && /Shared storage requires/.test(error.stderr));
  assert.equal(await readFile(file, 'utf8'), bytes);
  await assert.rejects(access(f.log), { code: 'ENOENT' });
});

test('TLS import refuses shared development storage before configuration or Docker writes', async t => {
  const settings = 'FOGD_PROFILE=shared\nFOGD_BUCKET_USER=operator\nFOGD_BUCKET_PASSWORD=fogd-local-development-only\n';
  const f = await fixture(t, settings), cert = join(f.root, 'certificate.pem'), key = join(f.root, 'key.pem');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost']);
  await assert.rejects(exec(process.execPath, [cli, 'tls', 'import', cert, key], { env: f.env, timeout: 10000 }), error =>
    error.code === 1 && /Shared storage requires/.test(error.stderr));
  assert.equal(await readFile(f.file, 'utf8'), settings);
  await assert.rejects(access(f.log), { code: 'ENOENT' });
});

for (const [name, controllerPassword, storagePassword, message] of [
  ['controller development password', 'fogd-local-development-only', 'private-password', /Shared storage requires/],
  ['storage development password', 'private-password', 'fogd-local-development-only', /Shared storage requires/],
  ['mismatched private passwords', 'private-password', 'different-private-password', /Shared storage credentials must match/],
]) test(`custom Compose refuses ${name} before mutation`, async t => {
  const settings = 'FOGD_PROFILE=shared\nFOGD_TLS=1\nFOGD_DEPLOY_TOKEN=\nFOGD_ADMIN_PASSWORD=private-admin\nFOGD_GATEWAY_TOKEN=private-gateway\nFOGD_BUCKET_USER=operator\nFOGD_BUCKET_PASSWORD=operator-private-password\n';
  const f = await fixture(t, settings), { source } = prebootFixture();
  Object.assign(source.services.controller.environment, { FOGD_PROFILE: 'shared', AWS_SECRET_ACCESS_KEY: controllerPassword });
  source.services.minio.environment.MINIO_ROOT_PASSWORD = storagePassword;
  const config = join(f.root, 'custom.json'); await writeFile(config, JSON.stringify(source));
  await writeFile(join(f.bin, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FOGD_TEST_DOCKER_LOG"\ncat "$FOGD_TEST_CONFIG"\n', { mode: 0o700 });
  await assert.rejects(exec(process.execPath, [cli, 'up'], { env: { ...f.env, FOGD_TEST_CONFIG: config }, timeout: 10000 }), error =>
    error.code === 1 && message.test(error.stderr));
  assert.equal(await readFile(f.file, 'utf8'), settings);
  assert.match(await readFile(f.log, 'utf8'), /^compose .*config --format json\n$/);
});

test('process storage credentials override the file without being copied into it', async t => {
  const settings = 'FOGD_PROFILE=shared\nFOGD_TLS=1\nFOGD_DEPLOY_TOKEN=\nFOGD_ADMIN_PASSWORD=private-admin\nFOGD_GATEWAY_TOKEN=private-gateway\nFOGD_BUCKET_USER=fogd-local\nFOGD_BUCKET_PASSWORD=fogd-local-development-only\n';
  const f = await fixture(t, settings);
  const result = await exec(process.execPath, ['--input-type=module', '-e', `import {prepareEnvironment} from ${JSON.stringify(bootstrap)}; const env=await prepareEnvironment(); if(env.FOGD_BUCKET_USER!=='operator'||env.FOGD_BUCKET_PASSWORD!=='process-private-password')throw new Error('Process precedence lost');`],
    { env: { ...f.env, FOGD_BUCKET_USER: 'operator', FOGD_BUCKET_PASSWORD: 'process-private-password' }, timeout: 10000 });
  assert.equal(result.stdout, '');
  assert.equal(await readFile(f.file, 'utf8'), settings);
  await assert.rejects(access(f.log), { code: 'ENOENT' });
});

test('custom Compose refusal can retain generated bootstrap secrets but never create resources', async t => {
  const settings = 'FOGD_BUCKET_USER=operator\nFOGD_BUCKET_PASSWORD=operator-private-password\n';
  const f = await fixture(t, settings), { source } = prebootFixture();
  Object.assign(source.services.controller.environment, { FOGD_PROFILE: 'shared', AWS_SECRET_ACCESS_KEY: 'fogd-local-development-only' });
  const config = join(f.root, 'custom.json'); await writeFile(config, JSON.stringify(source));
  await writeFile(join(f.bin, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$FOGD_TEST_DOCKER_LOG"\ncat "$FOGD_TEST_CONFIG"\n', { mode: 0o700 });
  await assert.rejects(exec(process.execPath, [cli, 'up', '--shared'], { env: { ...f.env, FOGD_TEST_CONFIG: config }, timeout: 10000 }), error =>
    error.code === 1 && /Shared storage requires/.test(error.stderr));
  const saved = await readFile(f.file, 'utf8');
  assert.ok(saved.startsWith(settings));
  assert.match(saved, /FOGD_ADMIN_PASSWORD=[a-f0-9]{64}/);
  assert.match(saved, /FOGD_GATEWAY_TOKEN=[a-f0-9]{64}/);
  assert.equal(saved.match(/FOGD_BUCKET_PASSWORD=/g).length, 1);
  assert.match(await readFile(f.log, 'utf8'), /^compose .*config --format json\n$/);
  await assert.rejects(access(join(f.root, '.fogd/installations')), { code: 'ENOENT' });
});
