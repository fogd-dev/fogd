import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { execute } from '../src/recovery/execute.mjs';
import { fingerprint } from '../src/recovery/bundle.mjs';
import { cronSnapshotSource } from './fixtures/cron-snapshot.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';
import { config, services, volumes } from './fixtures/recovery-layout.mjs';

const exec = promisify(execFile);
async function pendingBundle(t) {
  const id = '11111111-1111-4111-8111-111111111111';
  const state = { requirements: ['fogd-cron-activation-v1'], apps: {}, deployments: {
    [id]: { id, app: 'refresh', digest: 'a'.repeat(64), status: 'pending', step: 'submitted', resources: { script: 'refresh', crons: ['* * * * *'] } },
  } };
  return archiveBundle(t, state);
}
async function archiveBundle(t, state, evidence = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-preboot-restore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  await execute('tar', ['-cf', join(dir, 'controller.tar'), '-C', dir, './state.json']);
  const files = {};
  for (const name of ['compose.json', 'images.tar', ...volumes.map(value => `${value}.tar`)]) {
    if (name !== 'controller.tar') await writeFile(join(dir, name), name === 'compose.json' ? JSON.stringify(config()) : 'unused archive');
    files[name] = await fingerprint(join(dir, name));
  }
  const manifest = { format: 'fogd-stopped-v1', sourceProject: 'original', files,
    images: Object.fromEntries(services.map(name => [name, 'sha256:' + 'b'.repeat(64)])),
    runtimeProfile: { schema: 2, image: 'sha256:' + 'b'.repeat(64), binarySha256: 'c'.repeat(64) }, ...evidence };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { dir, manifest };
}
test('ordinary restore refuses checksummed pending cron history before Docker or target resources', async t => {
  const { dir } = await pendingBundle(t);
  const bin = join(dir, 'bin'), marker = join(dir, 'docker-called'), output = join(dir, 'target');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\necho called > "$FOGD_DOCKER_SENTINEL"\nexit 99\n', { mode: 0o700 });
  await assert.rejects(exec(process.execPath, [fileURLToPath(new URL('../bin/fogd.js', import.meta.url)), 'restore', dir, '--project', 'fresh', '--output', output], {
    env: { PATH: `${bin}:${process.env.PATH}`, FOGD_DOCKER_SENTINEL: marker },
  }), error => error.code === 1 && /matching independently checked runtime profile/.test(error.stderr));
  await assert.rejects(access(marker), { code: 'ENOENT' });
  await assert.rejects(access(output), { code: 'ENOENT' });
});


async function dockerHarness(dir, profile) {
  const bin = join(dir, 'bin'), driver = join(dir, 'docker.mjs'), log = join(dir, 'docker-calls.jsonl'), output = join(dir, 'target');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nexec "$FOGD_TEST_NODE" "$FOGD_TEST_DRIVER" "$@"\n', { mode: 0o700 });
  await writeFile(driver, `import {appendFileSync,readFileSync} from 'node:fs';function requireState(){return readFileSync(process.env.FOGD_TEST_STATE,'utf8')} const args=process.argv.slice(2);appendFileSync(process.env.FOGD_TEST_LOG,JSON.stringify(args)+'\\n');
    if(args[0]==='image'&&args[1]==='inspect')console.log(JSON.stringify(args.slice(2).map(Id=>({Id,Config:{WorkingDir:'/app',Env:Id===${JSON.stringify(profile.storageImage)}?['PATH=/usr/local/bin:/usr/bin:/bin']:['PATH=/usr/local/bin:/usr/bin:/bin','NODE_VERSION=26.2.0']}}))));
    else if(args[0]==='run') {
      if(args.at(-1).includes('const required ='))console.log('supported');
      else if(args.includes('/data/state.json'))console.log(requireState());
      else if(args.includes('--entrypoint'))console.log(JSON.stringify({binarySha256:process.env.FOGD_TEST_SUCCESS?'b'.repeat(64):'0'.repeat(64),supervisorSha256:'c'.repeat(64)}));
    }
    else if(!['ps','volume','network','image','compose'].includes(args[0]))process.exit(99);`);
  return { bin, driver, log, output };
}
test('checked internal policy refuses a wrong native digest after image load but before compose create', async t => {
  const { dir, manifest } = await pendingBundle(t), f = prebootFixture();
  manifest.images = Object.fromEntries(services.map(name => [name, name === 'minio' ? f.profile.storageImage : f.profile.image]));
  const { bin, driver, log, output } = await dockerHarness(dir, f.profile);
  const code = `import {restoreInstallation} from ${JSON.stringify(new URL('../src/recovery/restore.mjs', import.meta.url).href)}; await restoreInstallation(${JSON.stringify({ dir, manifest, config: f.source })}, 'fresh', ${JSON.stringify(output)}, null, ${JSON.stringify(f.profile)});`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: `${bin}:${process.env.PATH}`,
    FOGD_TEST_NODE: process.execPath, FOGD_TEST_DRIVER: driver, FOGD_TEST_LOG: log } }), error => error.code === 1 && /preboot verification failed/.test(error.stderr));
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.filter(args => ['image', 'run'].includes(args[0])).map(args => args.slice(0, 2)), [
    ['image', 'load'], ['image', 'inspect'], ['image', 'inspect'], ['image', 'inspect'], ['run', '--rm'],
  ]);
  assert.equal(calls.some(args => args[0] === 'compose'), false);
  await assert.rejects(access(join(output, 'compose.pending.json')), { code: 'ENOENT' });
  await assert.rejects(access(output), { code: 'ENOENT' });
});


test('normal scheduled retirement refuses its missing launch policy before querying the source Docker project', async t => {
  const source = cronSnapshotSource(); source.state.apps.refresh.slot = 'slot-2'; source.receipt.slot = 'slot-2';
  const { dir } = await archiveBundle(t, source.state, { cronRecovery: { schema: 1, apps: { refresh: source.receipt } } });
  const bin = join(dir, 'bin'), marker = join(dir, 'docker-called'), output = join(dir, 'target'); await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\necho called > "$FOGD_DOCKER_SENTINEL"\nexit 99\n', { mode: 0o700 });
  await assert.rejects(exec(process.execPath, [fileURLToPath(new URL('../bin/fogd.js', import.meta.url)), 'retire', dir,
    '--app', 'refresh', '--digest', source.receipt.digest, '--stop-scheduled-work', '--project', 'fresh', '--output', output], {
    env: { PATH: `${bin}:${process.env.PATH}`, FOGD_DOCKER_SENTINEL: marker },
  }), error => error.code === 1 && /matching independently checked runtime profile/.test(error.stderr));
  await assert.rejects(access(marker), { code: 'ENOENT' });
  await assert.rejects(access(output), { code: 'ENOENT' });
});


test('successful internal orchestration checks images before creating a sealed stopped configuration', async t => {
  const { dir, manifest } = await pendingBundle(t), f = prebootFixture(); f.source['x-private-metadata'] = { ignored: true };
  manifest.images = Object.fromEntries(services.map(name => [name, name === 'minio' ? f.profile.storageImage : f.profile.image]));
  const { bin, driver, log, output } = await dockerHarness(dir, f.profile);
  const code = `import {restoreInstallation} from ${JSON.stringify(new URL('../src/recovery/restore.mjs', import.meta.url).href)}; await restoreInstallation(${JSON.stringify({ dir, manifest, config: f.source })}, 'fresh', ${JSON.stringify(output)}, null, ${JSON.stringify(f.profile)});`;
  await exec(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: `${bin}:${process.env.PATH}`,
    FOGD_TEST_NODE: process.execPath, FOGD_TEST_DRIVER: driver, FOGD_TEST_LOG: log, FOGD_TEST_SUCCESS: '1', FOGD_TEST_STATE: join(dir, 'state.json') } });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.filter(args => ['image', 'run', 'compose'].includes(args[0])).slice(0, 7).map(args => args.slice(0, 2)), [
    ['image', 'load'], ['image', 'inspect'], ['image', 'inspect'], ['image', 'inspect'], ['run', '--rm'], ['run', '--rm'], ['compose', '--env-file'],
  ]);
  const sealed = JSON.parse(await readFile(join(output, 'compose.json'), 'utf8'));
  assert.equal(sealed['x-private-metadata'], undefined);
  assert.equal(sealed.services.controller.read_only, true);
  assert.deepEqual(sealed.services.controller.entrypoint, ['/usr/local/bin/node']);
  assert.deepEqual(sealed.services['slot-1-a'].entrypoint, ['/usr/local/bin/celld-supervisor']);
  assert.deepEqual(sealed.services['slot-1-a'].tmpfs, ['/tmp:rw,noexec,nosuid,nodev']);
  assert.equal(sealed.services.minio.read_only, true);
  assert.equal(calls.some(args => args[0] === 'compose' && args.includes('start')), false);
  assert.equal(calls.some(args => args[0] === 'compose' && args.includes('up')), false);
});
