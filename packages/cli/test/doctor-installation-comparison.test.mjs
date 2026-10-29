import test from 'node:test';
import assert from 'node:assert/strict';
import { compareInstalledRelease } from '../src/doctor/installation-comparison.mjs';
import { ObserverCleanupError } from '../src/observe/cleanup.mjs';
import { doctorOptions } from '../src/doctor/options.mjs';

const installation = { project: 'sample', entry: { image: 'sha256:' + 'b'.repeat(64) },
  config: { services: { controller: { environment: { FOGD_QUEUE_APPS: '0', FOGD_ADMIN_PASSWORD: 'private-admin-password' } } } } };
const backing = { volumes: [{ role: 'controller', mountpoint: '/var/lib/docker/volumes/sample_controller/_data' }] };
const release = { app: 'demo', resources: {}, migrations: [] };
const supported = { status: 'supported', reason: 'compatible', existingApp: true, r2Added: 0, appliedMigrations: 1, pendingMigrations: 0 };

test('comparison helper receives only candidate metadata and uses an existing read-only controller bind', async () => {
  const calls = [];
  const result = await compareInstalledRelease(installation, backing, release, async (args, options) => {
    calls.push({ args, options }); return args[0] === 'run' ? JSON.stringify(supported) : '';
  });
  assert.deepEqual(result, supported);
  const { args, options } = calls[0];
  assert.equal(args[args.indexOf('--network') + 1], 'none'); assert.equal(args[args.indexOf('--pull') + 1], 'never');
  assert.ok(args.includes('--read-only')); assert.equal(args.includes('--cap-add'), false);
  assert.ok(args.includes('type=bind,src=/var/lib/docker/volumes/sample_controller/_data,dst=/data,readonly'));
  assert.equal(args.some(value => value.startsWith('type=volume,')), false);
  assert.deepEqual(JSON.parse(options.inputText), { release, capabilities: { cronApps: true, queueApps: false } });
  assert.ok(!JSON.stringify(calls).includes('private-admin-password'));
  assert.equal(options.timeoutMs, 15000); assert.equal(options.maxOutputBytes, 4096);
  assert.equal(calls.at(-1).args[0], 'ps');
});
for (const response of [{ ...supported, private: 'secret' }, { ...supported, pendingMigrations: -1 }, { status: 'supported', reason: 'state' }, null]) {
  test(`malformed comparison output is refused: ${JSON.stringify(response)}`, async () => {
    await assert.rejects(compareInstalledRelease(installation, backing, release, async args => args[0] === 'run' ? JSON.stringify(response) : ''), /Invalid compatibility observation/);
  });
}
test('uncertain comparison cleanup remains fatal rather than a compatibility finding', async () => {
  await assert.rejects(compareInstalledRelease(installation, backing, release, async args => {
    if (args[0] === 'run') return JSON.stringify(supported);
    throw Error('private-docker-error');
  }), ObserverCleanupError);
});
test('local installation comparison requires an operator build check and excludes online mode', () => {
  const args = ['--project', 'app', '--name', 'demo', '--against-installation', 'sample'];
  assert.equal(doctorOptions(args, true)['against-installation'], 'sample');
  assert.throws(() => doctorOptions(args), /Unknown option/);
  assert.throws(() => doctorOptions([...args, '--online'], true), /Usage:/);
  assert.throws(() => doctorOptions(['--config', 'file', '--name', 'demo', '--against-installation', 'sample'], true), /Usage:/);
});

test('embedded reader enforces regular unlinked bounded state input before authoritative comparison', async t => {
  const { mkdtemp, writeFile, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execute } = await import('../src/recovery/execute.mjs');
  const root = await mkdtemp(join(tmpdir(), 'fogd-comparison-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let code;
  await compareInstalledRelease(installation, backing, release, async args => {
    if (args[0] !== 'run') return '';
    code = args.at(-1); return JSON.stringify(supported);
  });
  const valid = join(root, 'state.json'); await writeFile(valid, JSON.stringify({ apps: {}, deployments: {} }));
  const large = join(root, 'large.json'); await writeFile(large, Buffer.alloc(4194305, 32));
  const linked = join(root, 'linked.json'); await symlink(valid, linked);
  const inputText = JSON.stringify({ release: { app: 'demo', migrations: [], resources: { script: 'demo', d1: [], r2: [], durable: { bindings: [] } } }, capabilities: { cronApps: true, queueApps: false } });
  const read = path => execute(process.execPath, ['--input-type=module', '-e', code.replace("'/data/state.json'", JSON.stringify(path))], { inputText, timeoutMs: 5000, maxOutputBytes: 4096 });
  const result = JSON.parse(await read(valid)); assert.equal(result.status, 'supported'); assert.equal(result.existingApp, false);
  for (const path of [large, linked]) await assert.rejects(read(path));
});
