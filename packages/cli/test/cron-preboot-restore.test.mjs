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
import { config, services } from './fixtures/recovery-layout.mjs';
import { runtimeInstallation } from './fixtures/runtime-installation.mjs';
import { recoveryLayout } from '../src/recovery/layout.mjs';
import { sealRuntimeConfig } from '../src/runtime/cron-preboot.mjs';

const exec = promisify(execFile);
async function pendingBundle(t, source = config()) {
  const id = '11111111-1111-4111-8111-111111111111';
  const state = { requirements: ['fogd-cron-activation-v1'], apps: {}, deployments: {
    [id]: { id, app: 'refresh', digest: 'a'.repeat(64), status: 'pending', step: 'submitted', resources: { script: 'refresh', crons: ['* * * * *'] } },
  } };
  return archiveBundle(t, state, {}, source);
}
async function archiveBundle(t, state, evidence = {}, source = config()) {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-preboot-restore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'state.json'), JSON.stringify(state));
  await execute('tar', ['-cf', join(dir, 'controller.tar'), '-C', dir, './state.json']);
  const files = {};
  for (const name of recoveryLayout(source).archives) {
    if (name !== 'controller.tar') await writeFile(join(dir, name), name === 'compose.json' ? JSON.stringify(source) : 'unused archive');
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

test('ordinary restore cannot adopt snapshot runtime authority even without scheduled history', async t => {
  const { source, profile } = runtimeInstallation();
  const { dir } = await archiveBundle(t, { apps: {}, deployments: {} }, { runtimeProfile: profile }, source);
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
  await writeFile(driver, `import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';import{runtimePolicyIdentity}from ${JSON.stringify(new URL('../../platform/src/runtime-policy.mjs', import.meta.url).href)};function requireState(){return readFileSync(process.env.FOGD_TEST_STATE,'utf8')} const args=process.argv.slice(2);appendFileSync(process.env.FOGD_TEST_LOG,JSON.stringify(args)+'\\n');
    if(args[0]==='image'&&args[1]==='inspect')console.log(JSON.stringify(args.slice(2).map(Id=>({Id,Config:{WorkingDir:'/app',Env:Id===${JSON.stringify(profile.storageImage)}?['PATH=/usr/local/bin:/usr/bin:/bin']:['PATH=/usr/local/bin:/usr/bin:/bin','NODE_VERSION=26.2.0']}}))));
    else if(args[0]==='run') {
      if(args.includes('packages/platform/src/import-runtime-policy.mjs')){let text='';for await(const part of process.stdin)text+=part;const policy=JSON.parse(text);writeFileSync(process.env.FOGD_TEST_LOG+'.policy',text);console.log(JSON.stringify({family:policy.family,admission:policy.admission,identitySha256:process.env.FOGD_TEST_POLICY_MODE==='receipt'?'0'.repeat(64):runtimePolicyIdentity(policy)}));}
      else if(args.at(-1).includes('readRuntimePolicy')){let binding='';for await(const part of process.stdin)binding+=part;writeFileSync(process.env.FOGD_TEST_LOG+'.binding',binding);const policy=JSON.parse(readFileSync(process.env.FOGD_TEST_LOG+'.policy','utf8'));if(process.env.FOGD_TEST_POLICY_MODE==='readback')policy.admission='qualified';console.log(JSON.stringify(policy));}
      else if(args.at(-1).includes('const required ='))console.log('supported');
      else if(args.includes('/data/state.json'))console.log(requireState());
      else if(args.includes('--entrypoint'))console.log(JSON.stringify({binarySha256:process.env.FOGD_TEST_SUCCESS?'b'.repeat(64):'0'.repeat(64),supervisorSha256:'c'.repeat(64)}));
    }
    else if(!['ps','volume','network','image','compose'].includes(args[0]))process.exit(99);`);
  return { bin, driver, log, output };
}
test('checked internal policy refuses a wrong native digest after image load but before compose create', async t => {
  for (const installed of [false, true]) await t.test(installed ? 'installed runtime without app history' : 'legacy scheduled history', async t => {
    const f = installed ? runtimeInstallation() : prebootFixture();
    const { dir, manifest } = installed ? await archiveBundle(t, { apps: {}, deployments: {} }, {}, f.source) : await pendingBundle(t);
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

test('selected restore installs independent policy after data and refuses inconsistent installation receipts', async t => {
  for (const mode of ['success', 'receipt', 'readback']) await t.test(mode, async t => {
    const f = runtimeInstallation(), { dir, manifest } = await pendingBundle(t, f.source);
    manifest.images = Object.fromEntries(Object.entries(f.source.services).map(([name, service]) => [name, service.image]));
    const { bin, driver, log, output } = await dockerHarness(dir, f.profile);
    // A file outside the manifest cannot become execution authority.
    await writeFile(join(dir, 'runtime-policy.tar'), 'forged authority');
    const code = `import {restoreInstallation} from ${JSON.stringify(new URL('../src/recovery/restore.mjs', import.meta.url).href)}; await restoreInstallation(${JSON.stringify({ dir, manifest, config: f.source })}, 'fresh', ${JSON.stringify(output)}, null, ${JSON.stringify(f.profile)});`;
    const run = exec(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: `${bin}:${process.env.PATH}`,
      FOGD_TEST_NODE: process.execPath, FOGD_TEST_DRIVER: driver, FOGD_TEST_LOG: log, FOGD_TEST_SUCCESS: '1',
      FOGD_TEST_STATE: join(dir, 'state.json'), FOGD_TEST_POLICY_MODE: mode } });
    if (mode === 'success') await run;
    else await assert.rejects(run, error => error.code === 1 && /policy.*differs/.test(error.stderr));
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const policyRuns = calls.filter(args => args[0] === 'run' && args.some(arg => arg.startsWith('type=volume,src=fresh_runtime-policy,dst=/data')));
    assert.equal(policyRuns.some(args => args.includes('tar')), false);
    const install = calls.findIndex(args => args.includes('packages/platform/src/import-runtime-policy.mjs'));
    const stateWrite = calls.findIndex(args => args.includes('run') && args.at(-1).includes("saveJson('/data/state.json'"));
    assert.ok(stateWrite >= 0 && install > stateWrite);
    assert.ok(policyRuns.some(args => args.includes('find')));
    assert.equal(calls[install][calls[install].indexOf('--entrypoint') + 1], '/usr/local/bin/node');
    if (mode !== 'receipt') {
      const readback = calls.find(args => args[0] === 'run' && args.at(-1).includes('readRuntimePolicy'));
      assert.ok(readback.includes('type=volume,src=fresh_runtime-policy,dst=/data,readonly'));
      assert.equal(readback.includes('--cap-add'), false);
      assert.equal(readback.join(' ').includes('private-password'), false);
      assert.deepEqual(JSON.parse(await readFile(log + '.binding', 'utf8')), Object.fromEntries(
        ['FOGD_BUCKET', 'S3_ENDPOINT', 'AWS_REGION', 'FOGD_SLOTS'].map(key => [key, f.source.services.controller.environment[key]])));
    }
    const target = join(output, 'compose.json'), pending = join(output, 'compose.pending.json');
    if (mode === 'success') {
      await access(target); await assert.rejects(access(pending), { code: 'ENOENT' });
      assert.deepEqual(JSON.parse(await readFile(log + '.policy', 'utf8')), f.profile);
    } else {
      await access(pending); await assert.rejects(access(target), { code: 'ENOENT' });
    }
    assert.equal(calls.some(args => args[0] === 'compose' && (args.includes('up') || args.includes('start'))), false);
  });
});

test('policy installer refuses unsealed launches and mismatched images before any Docker call', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-policy-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'), marker = join(dir, 'docker-called'); await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\necho called > "$FOGD_DOCKER_SENTINEL"\nexit 99\n', { mode: 0o700 });
  for (const change of [
    c => { c.services.controller.read_only = false; },
    c => { c.services.controller.image = 'sha256:' + '0'.repeat(64); },
    c => { c.services.minio.image = 'sha256:' + '0'.repeat(64); },
  ]) {
    const { source, profile } = runtimeInstallation(), config = sealRuntimeConfig(source, profile); change(config);
    const code = `import {installRuntimePolicy} from ${JSON.stringify(new URL('../src/runtime/install-policy.mjs', import.meta.url).href)}; await installRuntimePolicy(${JSON.stringify(config)}, ${JSON.stringify(profile)});`;
    await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code], {
      env: { PATH: `${bin}:${process.env.PATH}`, FOGD_DOCKER_SENTINEL: marker },
    }), error => error.code === 1 && /requires the sealed launch configuration|matching independently checked runtime profile/.test(error.stderr));
    await assert.rejects(access(marker), { code: 'ENOENT' });
  }
});
