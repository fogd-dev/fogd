import test from 'node:test';
import assert from 'node:assert/strict';
import { prebootFixture as fixture } from './fixtures/cron-preboot.mjs';
import { cronRestoreConfig } from '../src/runtime/cron-preboot.mjs';
import { verifyCronRuntimeImage, verifyCronStorageImage } from '../src/runtime/cron-image.mjs';

const imageConfig = image => [{ Id: image, Config: { WorkingDir: '/app', Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_VERSION=26.2.0'] } }];
const state = { requirements: ['fogd-cron-activation-v1'], apps: {}, deployments: {} };

test('scheduled restore seals checked program files and keeps writable state mounts and source unchanged', () => {
  const f = fixture(), sealed = cronRestoreConfig(state, f.source, f.profile);
  assert.equal(sealed.services['slot-1-a'].read_only, true);
  assert.equal(sealed.services['slot-1-a'].build, undefined);
  assert.equal(sealed.services['slot-1-a'].pull_policy, 'never');
  assert.deepEqual(sealed.services['slot-1-a'].entrypoint, ['/usr/local/bin/celld-supervisor']);
  assert.deepEqual(sealed.services['slot-1-a'].tmpfs, ['/tmp:rw,noexec,nosuid,nodev']);
  assert.deepEqual(sealed.services['slot-1-a'].cap_drop, ['ALL']);
  assert.deepEqual(sealed.services['slot-1-a'].security_opt, ['no-new-privileges:true']);
  assert.deepEqual(sealed.services['slot-1-a'].volumes, [{ type: 'volume', source: 'slot-1-a', target: '/var/lib/celld' }]);
  assert.deepEqual(sealed.services.controller.entrypoint, ['/usr/local/bin/node']);
  assert.deepEqual(sealed.services.controller.command, ['packages/platform/src/main.mjs']);
  assert.deepEqual(sealed.services['bucket-init'].command, ['packages/runtime/src/init-bucket.mjs']);
  assert.deepEqual(sealed.services.workerd.command, ['packages/runtime/src/serve.mjs']);
  assert.equal(f.source.services['slot-1-a'].read_only, undefined);
  assert.equal(f.source.services['slot-1-a'].build, '.');
  assert.equal(sealed.services.minio.read_only, true);
  assert.deepEqual(sealed.services.minio.entrypoint, ['/usr/local/bin/minio']);
});

test('every scheduled history form requires caller authority while ordinary restore remains unchanged', () => {
  const f = fixture();
  for (const history of [state, { apps: { old: { retirement: { cron: {} } } }, deployments: {} },
    { apps: {}, deployments: { pending: { resources: { crons: [] } } } }]) {
    assert.throws(() => cronRestoreConfig(history, f.source), /independently checked runtime profile/);
  }
  assert.equal(cronRestoreConfig({ apps: {}, deployments: {} }, f.source), f.source);
  assert.equal(cronRestoreConfig(null, f.source), f.source);
});

test('startup refuses image, identity, provider and process-loading drift without exposing private values', () => {
  for (const alter of [
    f => { f.source.services['slot-1-a'].image = 'mutable:tag'; },
    f => { f.profile.binarySha256 = 'not-a-digest'; },
    f => { f.profile.fleets.pop(); },
    f => { f.profile.networks = null; },
    f => { f.profile.networks = { control: '', 'fleet-1': null, 'fleet-2': false }; },
    f => { f.profile.fleets[0].nodes[0].id = 'another-node'; },
    f => { f.source.services['slot-1-a'].command.push('--bucket', 's3://private-other'); },
    f => { f.source.services['slot-1-a'].entrypoint = ['sh', '-c']; },
    f => { f.source.services['slot-1-a'].environment.CELLD_CLOUD = '1'; },
    f => { f.source.services['slot-1-a'].environment.AWS_ENDPOINT_URL = 'http://private-other'; },
    f => { f.source.services['slot-1-a'].environment.AWS_SECRET_ACCESS_KEY = 'private-other'; },
    f => { f.source.services['slot-1-a'].environment.CELLD_TEST_SCRIPT_PATH = '/var/lib/celld/private'; },
    f => { f.source.services.controller.environment.NODE_OPTIONS = '--import=/private'; },
    f => { f.source.services.controller.environment.CELLD_TEST_CRONS = '* * * * *'; },
    f => { f.source.services.controller.command = ['node', '/private']; },
    f => { f.source.services['bucket-init'].environment.AWS_REGION = 'private-other'; },
    f => { f.source.services.workerd.command = ['celld']; },
    f => { f.source.services.workerd.environment.FOGD_CONTROLLER = 'private-other:8083'; },
    f => { f.source.services.controller.privileged = true; },
    f => { f.source.services.minio.image = 'mutable:tag'; },
    f => { f.source.services.minio.command = ['other']; },
    f => { f.source.services.minio.environment.MINIO_ROOT_PASSWORD = 'private-other'; },
    f => { f.source.services['slot-1-a'].networks['fleet-1'] = { aliases: ['minio'] }; },
    f => { f.source.services.controller.tmpfs = ['/app']; },
    f => { f.source.include = ['private-override.yaml']; },
    f => { f.source.configs = { private: {} }; },
    f => { f.source.volumes.controller.driver_opts = { type: 'none', device: '/private', o: 'bind' }; },
    f => { f.source.networks.control.driver = 'private'; },
    f => { f.source.networks.control.ipam = { config: [] }; },
    f => { f.source.services.controller.environment.OPENSSL_CONF = '/private'; },
    f => { f.source.services['bucket-init'].environment.GCONV_PATH = '/private'; },
    f => { f.source.services.workerd.environment.FOGD_TLS_DIR = '/private'; },
    f => { f.source.services.workerd.environment.FOGD_RUNTIME_DIR = '/private'; },
    f => { f.source.services.minio.environment = ['OPENSSL_CONF=/private']; },
    f => { f.source.services['slot-1-a'].volumes[0].volume = { subpath: 'private' }; },
  ]) {
    const f = fixture(); alter(f);
    assert.throws(() => cronRestoreConfig(state, f.source, f.profile), error => !error.message.includes('private'));
  }
});

test('image preboot hashes exact executable and supervisor without mounting or booting application state', async () => {
  const f = fixture(), calls = [];
  await verifyCronRuntimeImage(f.profile, async (args, options) => { calls.push({ args, options }); if (args[0] === 'image') return JSON.stringify(imageConfig(f.profile.image)); return JSON.stringify({ binarySha256: 'b'.repeat(64), supervisorSha256: 'c'.repeat(64) }); });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['image', 'inspect', f.profile.image]);
  assert.deepEqual(calls[1].args.slice(0, 7), ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL']);
  assert.equal(calls[1].args.includes('--mount'), false);
  assert.equal(calls[1].args.includes(f.profile.image), true);
  assert.equal(calls[1].args[calls[1].args.indexOf('--entrypoint') + 1], '/usr/local/bin/node');
  assert.equal(calls[1].options.timeoutMs, 15000);
});

test('wrong native file, malformed proof and failed inspection refuse preboot without private diagnostics', async () => {
  for (const response of [
    async () => JSON.stringify({ binarySha256: '0'.repeat(64), supervisorSha256: 'c'.repeat(64) }),
    async () => JSON.stringify({ binarySha256: 'b'.repeat(64), supervisorSha256: '0'.repeat(64) }),
    async () => 'private-invalid-json',
    async () => { throw Error('private-runtime-diagnostic'); },
  ]) {
    const f = fixture();
    await assert.rejects(verifyCronRuntimeImage(f.profile, async args => args[0] === 'image' ? JSON.stringify(imageConfig(f.profile.image)) : response()), error => /preboot verification failed/.test(error.message) && !error.message.includes('private'));
  }
});

test('image-declared volumes, loader environment and writable search paths refuse before any container', async () => {
  for (const alter of [
    image => { image.Config.Volumes = { '/usr/local/bin': {} }; },
    image => { image.Config.Healthcheck = { Test: ['CMD', 'celld'] }; },
    image => { image.Id = 'sha256:' + '0'.repeat(64); },
    image => { image.Config.Env.push('NODE_OPTIONS=--import=/private'); },
    image => { image.Config.Env[0] = 'PATH=/tmp:/usr/local/bin'; },
    image => { image.Config.Env.unshift('PATH=/var/lib/celld:/usr/local/bin:/bin'); },
    image => { image.Config.WorkingDir = '/private'; },
    image => { image.Config.User = 'private-user'; },
  ]) {
    const f = fixture(), images = imageConfig(f.profile.image), calls = []; alter(images[0]);
    await assert.rejects(verifyCronRuntimeImage(f.profile, async args => { calls.push(args[0]); return JSON.stringify(images); }), /preboot verification failed/);
    assert.deepEqual(calls, ['image']);
  }
});

test('private network overrides require a complete nonoverlapping launch policy', () => {
  const f = fixture();
  f.profile.networks = { control: '10.252.232.0/24', 'fleet-1': '10.252.233.0/24', 'fleet-2': '10.252.234.0/24' };
  for (const [name, subnet] of Object.entries(f.profile.networks)) f.source.networks[name].ipam = { config: [{ subnet }] };
  const sealed = cronRestoreConfig(state, f.source, f.profile);
  assert.deepEqual(sealed.networks.control.ipam, { config: [{ subnet: '10.252.232.0/24' }] });
  f.source.networks.control.ipam.config[0].subnet = '10.252.235.0/24';
  assert.throws(() => cronRestoreConfig(state, f.source, f.profile), { code: 'CRON_PREBOOT_REFUSED' });
});

test('image verification snapshots caller policy before asynchronous image inspection', async () => {
  const f = fixture(), calls = [];
  await verifyCronRuntimeImage(f.profile, async args => {
    calls.push(args[0]);
    if (args[0] === 'image') { f.profile.binarySha256 = '0'.repeat(64); return JSON.stringify(imageConfig(f.profile.image)); }
    return JSON.stringify({ binarySha256: 'b'.repeat(64), supervisorSha256: 'c'.repeat(64) });
  });
  assert.deepEqual(calls, ['image', 'run']);
  assert.equal(f.profile.binarySha256, '0'.repeat(64));
});

test('storage image refuses anonymous mounts, startup loaders and active healthchecks before any container', async () => {
  for (const alter of [
    image => { image.Config.Volumes = { '/usr/local/bin': {} }; },
    image => { image.Config.Healthcheck = { Test: ['CMD', 'celld'] }; },
    image => { image.Config.Env.push('MINIO_CONFIG_ENV_FILE=/data/private'); },
    image => { image.Config.Env.push('OPENSSL_CONF=/data/private'); },
    image => { image.Config.Env[0] = 'PATH=/data:/usr/bin'; },
    image => { image.Config.User = 'private-user'; },
  ]) {
    const f = fixture(), images = [{ Id: f.profile.storageImage, Config: { Env: ['PATH=/usr/local/bin:/usr/bin:/bin'] } }], calls = [];
    alter(images[0]);
    await assert.rejects(verifyCronStorageImage(f.profile.storageImage, async args => { calls.push(args[0]); return JSON.stringify(images); }), /preboot verification failed/);
    assert.deepEqual(calls, ['image']);
  }
});

test('a sealed snapshot can be sealed again without changing its launch policy', () => {
  const f = fixture(), sealed = cronRestoreConfig(state, f.source, f.profile);
  assert.deepEqual(cronRestoreConfig(state, sealed, f.profile), sealed);
  sealed.services.controller.entrypoint = ['/var/lib/fogd/node'];
  assert.throws(() => cronRestoreConfig(state, sealed, f.profile), { code: 'CRON_PREBOOT_REFUSED' });
});

test('sealed controller and utility programs reject changed arguments and mixed node forms', () => {
  for (const alter of [
    config => { config.services.controller.command = ['private.mjs']; },
    config => { config.services.workerd.command = ['private.mjs']; },
    config => { config.services['bucket-init'].command = ['private.mjs']; },
    config => { delete config.services['bucket-init'].command; },
    config => { config.services.controller.command.unshift('node'); },
  ]) {
    const f = fixture(), sealed = cronRestoreConfig(state, f.source, f.profile); alter(sealed);
    assert.throws(() => cronRestoreConfig(state, sealed, f.profile), { code: 'CRON_PREBOOT_REFUSED' });
  }
});
