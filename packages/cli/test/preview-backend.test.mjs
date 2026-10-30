import test from 'node:test';
import assert from 'node:assert/strict';
import { previewBackendCommand, runPreviewBackend } from '../src/preview/backend.mjs';

const input = { FOGD_PREVIEW_ID: '1'.repeat(32), FOGD_PREVIEW_STORAGE_PASSWORD: '2'.repeat(64),
  AWS_ACCESS_KEY_ID: 'production', AWS_SECRET_ACCESS_KEY: 'production', S3_ENDPOINT: 'https://production.test', NODE_OPTIONS: '--inspect',
  CELLD_BUCKET: 's3://production/data', CELLD_NODE: 'production', PATH: '/tmp', FOGD_ADMIN_PASSWORD: 'production', FOGD_PREVIEW_UNBOUND: 'production' };

test('storage and initialization share only explicit preview credentials and bucket identity', () => {
  const storage = previewBackendCommand('minio', input), init = previewBackendCommand('bucket-init', input);
  assert.equal(storage.executable, '/usr/local/bin/minio'); assert.deepEqual(storage.args, ['server', '/data', '--console-address', ':9001']);
  assert.equal(init.executable, '/usr/local/bin/node'); assert.deepEqual(init.args, ['packages/runtime/src/init-bucket.mjs']);
  assert.equal(init.env.AWS_ACCESS_KEY_ID, storage.env.MINIO_ROOT_USER);
  assert.equal(init.env.AWS_SECRET_ACCESS_KEY, storage.env.MINIO_ROOT_PASSWORD);
  assert.equal(init.env.S3_ENDPOINT, 'http://minio:9000'); assert.equal(init.env.FOGD_BUCKET, `fogd-preview-${input.FOGD_PREVIEW_ID}`);
  for (const command of [storage, init]) assert.equal(JSON.stringify(command).includes('production'), false);
});

test('native roles have distinct derived identities and run directly without an automatic restart loop', () => {
  const commands = ['slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b'].map(role => previewBackendCommand(role, input));
  assert.equal(new Set(commands.map(command => command.env.CELLD_NODE)).size, 4);
  assert.equal(new Set(commands.map(command => command.env.CELLD_BUCKET)).size, 2);
  for (const [index, command] of commands.entries()) {
    assert.equal(command.executable, '/usr/local/bin/celld'); assert.equal(command.cwd, '/app');
    assert.equal(command.args.at(-1), `slot-${index < 2 ? 1 : 2}-${index % 2 ? 'b' : 'a'}:8081`);
    assert.equal(command.env.CELLD_CLOUD, '0'); assert.equal(JSON.stringify(command).includes('production'), false);
    assert.equal(Object.hasOwn(command.env, 'NODE_OPTIONS'), false);
    assert.equal(Object.hasOwn(command.env, 'FOGD_PREVIEW_STORAGE_PASSWORD'), false);
  }
});

test('a new preview derives separate bucket, namespace, credentials and native identities', () => {
  const first = previewBackendCommand('slot-1-a', input), next = previewBackendCommand('slot-1-a', { ...input, FOGD_PREVIEW_ID: '3'.repeat(32), FOGD_PREVIEW_STORAGE_PASSWORD: '4'.repeat(64) });
  for (const name of ['FOGD_BUCKET', 'CELLD_BUCKET', 'CELLD_NODE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) assert.notEqual(first.env[name], next.env[name]);
});

for (const [role, env] of [['controller', input], ['workerd', input], ['minio', {}], ['minio', { ...input, FOGD_PREVIEW_ID: '../production' }], ['minio', { ...input, FOGD_PREVIEW_STORAGE_PASSWORD: 'short' }]]) {
  test(`unsupported backend role/configuration refuses: ${role}/${env.FOGD_PREVIEW_ID || 'absent'}/${env.FOGD_PREVIEW_STORAGE_PASSWORD?.length || 0}`, () => {
    assert.throws(() => previewBackendCommand(role, env), /fixed role/);
  });
}

test('an expired backend role starts no native or storage child', async () => {
  const observed = await runPreviewBackend('minio', new Date(Date.now() - 1).toISOString(), input);
  assert.equal(observed.started, false); assert.equal(observed.outcome, 'expired'); assert.equal(observed.childExitConfirmed, true);
});
