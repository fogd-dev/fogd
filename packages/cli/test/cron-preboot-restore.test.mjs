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
import { freshRuntimePlan } from '../src/runtime/selection-plan.mjs';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { recoveryLayout } from '../src/recovery/layout.mjs';
import { sealRuntimeConfig } from '../src/runtime/cron-preboot.mjs';
import { runtimeCli } from './fixtures/runtime-cli.mjs';

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
  await writeFile(driver, `import {appendFileSync,readFileSync,writeFileSync,existsSync} from 'node:fs';import{runtimePolicyIdentity}from ${JSON.stringify(new URL('../../platform/src/runtime-policy.mjs', import.meta.url).href)};function requireState(){return readFileSync(process.env.FOGD_TEST_STATE,'utf8')} const args=process.argv.slice(2);appendFileSync(process.env.FOGD_TEST_LOG,JSON.stringify(args)+'\\n');
    if(args[0]==='ps'&&args.includes('label=com.docker.compose.project=original')&&(process.env.FOGD_TEST_RUNNING_SOURCE==='before'||(process.env.FOGD_TEST_RUNNING_SOURCE==='final'&&existsSync(process.env.FOGD_TEST_LOG+'.created'))))console.log('running-source');
    else if(args[0]==='inspect'&&args.includes('running-source'))console.log(JSON.stringify([{State:{Running:true}}]));
    else if(args[0]==='network'&&args[1]==='ls'&&args.length===3&&args[2]==='-q'&&process.env.FOGD_TEST_OVERLAP)console.log('a'.repeat(64));
    else if(args[0]==='network'&&args[1]==='inspect'&&process.env.FOGD_TEST_OVERLAP)console.log(JSON.stringify([{Id:'a'.repeat(64),IPAM:{Config:[{Subnet:'10.0.0.0/8'}]}}]));
    else if(args[0]==='info')console.log(JSON.stringify({OSType:'linux',Architecture:'aarch64'}));
    else if(args[0]==='image'&&args[1]==='inspect')console.log(JSON.stringify(args.slice(2).map(Id=>({Id,Os:'linux',Architecture:'arm64',Config:{WorkingDir:'/app',Env:Id===${JSON.stringify(profile.storageImage)}?['PATH=/usr/local/bin:/usr/bin:/bin']:['PATH=/usr/local/bin:/usr/bin:/bin','NODE_VERSION=26.2.0']}}))));
    else if(args[0]==='run') {
      if(args.includes('packages/platform/src/import-runtime-policy.mjs')){let text='';for await(const part of process.stdin)text+=part;const policy=JSON.parse(text);writeFileSync(process.env.FOGD_TEST_LOG+'.policy',text);console.log(JSON.stringify({family:policy.family,admission:policy.admission,identitySha256:process.env.FOGD_TEST_POLICY_MODE==='receipt'?'0'.repeat(64):runtimePolicyIdentity(policy)}));}
      else if(args.at(-1).includes('readRuntimePolicy')){let binding='';for await(const part of process.stdin)binding+=part;writeFileSync(process.env.FOGD_TEST_LOG+'.binding',binding);const policy=JSON.parse(readFileSync(process.env.FOGD_TEST_LOG+'.policy','utf8'));if(process.env.FOGD_TEST_POLICY_MODE==='readback')policy.admission='qualified';console.log(JSON.stringify(policy));}
      else if(args.at(-1).includes('programInventory')){if(process.env.FOGD_TEST_REQUIRE_UNRESERVED&&existsSync(process.env.FOGD_TEST_REQUIRE_UNRESERVED))process.exit(97);console.log(JSON.stringify(JSON.parse(readFileSync(process.env.FOGD_TEST_CATALOG,'utf8'))[0].sourceFiles));}
      else if(args.at(-1).includes('const required ='))console.log(process.env.FOGD_TEST_CAP_FAIL?'mismatch':'supported');
      else if(args.at(-1).includes("saveJson('/data/state.json'")){let text='';for await(const part of process.stdin)text+=part;writeFileSync(process.env.FOGD_TEST_LOG+'.state',text);}
      else if(args.includes('/data/state.json'))console.log(existsSync(process.env.FOGD_TEST_LOG+'.state')?readFileSync(process.env.FOGD_TEST_LOG+'.state','utf8'):requireState());
      else if(args.includes('--entrypoint'))console.log(JSON.stringify({binarySha256:process.env.FOGD_TEST_SUCCESS?${JSON.stringify(profile.binarySha256)}:'0'.repeat(64),supervisorSha256:${JSON.stringify(profile.supervisorSha256)}}));
    }
    else if(args[0]==='compose'&&args.includes('create')){writeFileSync(process.env.FOGD_TEST_LOG+'.created','created');if(process.env.FOGD_TEST_CREATE_FAIL)process.exit(91);}
    else if(!['ps','volume','network','image','compose'].includes(args[0]))process.exit(99);`);
  return { bin, driver, log, output };
}

test('public recovery commands install independent network plans into the target policy and configuration', async t => {
  for (const command of ['restore', 'retire']) await t.test(command, async t => {
    const entry = { ...runtimeFamilies()[0], admission: 'qualified' }, { source } = prebootFixture(), f = cronSnapshotSource();
    f.state.apps.refresh.slot = 'slot-2'; f.receipt.slot = 'slot-2';
    for (const [name, service] of Object.entries(source.services)) service.image = name === 'minio' ? entry.storageImage : entry.image;
    const plan = freshRuntimePlan(source, entry), { dir, manifest } = await archiveBundle(t, f.state, { cronRecovery: { schema: 1, apps: { refresh: f.receipt } } }, plan.config);
    manifest.images = Object.fromEntries(Object.entries(plan.config.services).map(([name, service]) => [name, service.image]));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const cli = await runtimeCli(dir, 'qualified'), h = await dockerHarness(dir, plan.policy), networkFile = join(dir, 'networks.json');
    const networks = { control: '10.253.180.0/24', 'fleet-1': '10.253.181.0/24', 'fleet-2': '10.253.182.0/24' };
    await writeFile(networkFile, JSON.stringify(networks));
    const args = [cli.cli, command, dir, '--project', 'fresh', '--output', h.output, '--runtime', entry.id, '--expected-identity', runtimePolicyIdentity(plan.policy), '--network-plan', networkFile];
    if (command === 'retire') args.push('--app', 'refresh', '--digest', f.receipt.digest, '--stop-scheduled-work');
    const env = { ...process.env, FOGD_HOME: dir, PATH: `${h.bin}:${process.env.PATH}`, FOGD_TEST_NODE: process.execPath,
      FOGD_TEST_DRIVER: h.driver, FOGD_TEST_LOG: h.log, FOGD_TEST_SUCCESS: '1', FOGD_TEST_STATE: join(dir, 'state.json'), FOGD_TEST_CATALOG: cli.catalog };
    await assert.rejects(exec(process.execPath, args, { env: { ...env, FOGD_TEST_OVERLAP: '1' } }), /overlaps an existing Docker subnet/);
    await assert.rejects(access(h.output), { code: 'ENOENT' });
    await assert.rejects(access(join(dir, '.fogd/installations/fresh')), { code: 'ENOENT' });
    await exec(process.execPath, args, { env });
    const installed = JSON.parse(await readFile(h.log + '.policy')), config = JSON.parse(await readFile(join(h.output, 'compose.json')));
    assert.deepEqual(installed.networks, networks);
    for (const [name, subnet] of Object.entries(networks)) assert.deepEqual(config.networks[name].ipam.config, [{ subnet }]);
    const restored = JSON.parse(await readFile(join(h.output, 'restored.json')));
    assert.equal(restored.identitySha256, runtimePolicyIdentity(installed));
    assert.equal(restored.runtimeFamily, entry.id);
    const calls = (await readFile(h.log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.some(args => args[0] === 'image' && args[1] === 'load'), false);
    assert.equal(calls.some(args => args.includes('--build') || args.includes('start') || args.includes('up')), false);
  });
});
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
      assert.ok(readback.includes('type=volume,src=fresh_runtime-policy,dst=/data,volume-nocopy,readonly'));
      assert.equal(readback[readback.indexOf('--pull') + 1], 'never');
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


test('selected recovery uses cached catalog programs and fences a partial create without loading snapshot images', async t => {
  for (const mode of ['success', 'create', 'source', 'final-source', 'catalog', 'capability']) await t.test(mode, async t => {
    const fail = mode !== 'success';
    const entry = runtimeFamilies()[0], { source } = prebootFixture();
    for (const [name, service] of Object.entries(source.services)) service.image = name === 'minio' ? entry.storageImage : entry.image;
    const plan = freshRuntimePlan(source, entry), { dir, manifest } = mode === 'capability' ? await pendingBundle(t, plan.config) : await archiveBundle(t, { apps: {}, deployments: {} }, {}, plan.config);
    manifest.images = Object.fromEntries(Object.entries(plan.config.services).map(([name, service]) => [name, service.image]));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const { bin, driver, log, output } = await dockerHarness(dir, plan.policy);
    const selection = { runtime: entry.id, candidateEnrollment: true, expectedIdentity: runtimePolicyIdentity(plan.policy) };
    const code = `import{restore}from ${JSON.stringify(new URL('../src/recovery/restore.mjs', import.meta.url).href)};await restore(${JSON.stringify(dir)},'fresh',${JSON.stringify(output)},${JSON.stringify(selection)});`;
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FOGD_HOME: dir, FOGD_TEST_NODE: process.execPath, FOGD_TEST_DRIVER: driver, FOGD_TEST_LOG: log, FOGD_TEST_SUCCESS: mode === 'catalog' ? '' : '1', FOGD_TEST_CAP_FAIL: mode === 'capability' ? '1' : '', FOGD_TEST_REQUIRE_UNRESERVED: join(dir, '.fogd/installations/fresh'), FOGD_TEST_STATE: join(dir, 'state.json'), FOGD_TEST_CATALOG: fileURLToPath(new URL('../src/runtime/catalog.json', import.meta.url)), ...(mode === 'create' ? { FOGD_TEST_CREATE_FAIL: '1' } : {}), ...(mode.includes('source') ? { FOGD_TEST_RUNNING_SOURCE: mode === 'source' ? 'before' : 'final' } : {}) };
    const run = exec(process.execPath, ['--input-type=module', '-e', code], { env });
    if (fail) await assert.rejects(run, error => error.code === 1 && /command failed \(91\)|Project still has running containers|preboot verification failed|capability differs/.test(error.stderr));
    else assert.match((await run).stdout, /fogd up --installation fresh/);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.some(args => args[0] === 'image' && args[1] === 'load'), false);
    if (['catalog', 'capability'].includes(mode)) {
      assert.equal(calls.some(args => args.includes('--mount') || args[0] === 'compose'), false);
      await assert.rejects(access(join(dir, '.fogd')), { code: 'ENOENT' });
      await assert.rejects(access(output), { code: 'ENOENT' }); return;
    }
    if (mode === 'source') {
      assert.equal(calls.some(args => ['run', 'image', 'compose'].includes(args[0])), false);
      await assert.rejects(access(join(dir, '.fogd')), { code: 'ENOENT' }); return;
    }
    assert.ok(calls.some(args => args.at(-1).includes('programInventory')));
    assert.ok(calls.findIndex(args => args.at(-1).includes('programInventory')) < calls.findIndex(args => args[0] === 'compose'));
    const pending = join(dir, '.fogd/installations/fresh/restore.pending.json');
    if (fail) {
      await access(pending);
      await assert.rejects(exec(process.execPath, [fileURLToPath(new URL('../bin/fogd.js', import.meta.url)), 'up', '--installation', 'fresh'], { env }), error => /Restoration is incomplete/.test(error.stderr));
    } else {
      await assert.rejects(access(pending), { code: 'ENOENT' });
      assert.deepEqual(JSON.parse(await readFile(join(dir, '.fogd/installations/fresh/compose.json'))), JSON.parse(await readFile(join(output, 'compose.json'))));
      const restored = JSON.parse(await readFile(join(output, 'restored.json')));
      assert.equal(restored.runtimeFamily, entry.id); assert.equal(restored.identitySha256, selection.expectedIdentity);
    }
    assert.equal(calls.some(args => args.includes('--build') || args.includes('start') || args.includes('up')), false);
  });
});

test('legacy CLI recovery cannot enter an enrolled name or an existing output directory', async t => {
  for (const collision of ['enrollment', 'output']) await t.test(collision, async t => {
    const { dir } = await archiveBundle(t, { apps: {}, deployments: {} }), harness = await dockerHarness(dir, prebootFixture().profile);
    if (collision === 'enrollment') await mkdir(join(dir, '.fogd/installations/fresh'), { recursive: true });
    else await mkdir(harness.output);
    await assert.rejects(exec(process.execPath, [fileURLToPath(new URL('../bin/fogd.js', import.meta.url)), 'restore', dir, '--project', 'fresh', '--output', harness.output], {
      env: { ...process.env, FOGD_HOME: dir, PATH: `${harness.bin}:${process.env.PATH}`, FOGD_TEST_NODE: process.execPath, FOGD_TEST_DRIVER: harness.driver, FOGD_TEST_LOG: harness.log },
    }), error => error.code === 1 && /enrollment already exists|output already exists/.test(error.stderr));
    await assert.rejects(access(harness.log), { code: 'ENOENT' });
  });
});


test('selected retirement installs the projected policy, preserves evidence and skips retired replica archives', async t => {
  const entry = runtimeFamilies()[0], { source } = prebootFixture(), f = cronSnapshotSource();
  f.state.apps.refresh.slot = 'slot-2'; f.receipt.slot = 'slot-2';
  for (const [name, service] of Object.entries(source.services)) service.image = name === 'minio' ? entry.storageImage : entry.image;
  const plan = freshRuntimePlan(source, entry), { dir, manifest } = await archiveBundle(t, f.state, { cronRecovery: { schema: 1, apps: { refresh: f.receipt } } }, plan.config);
  manifest.images = Object.fromEntries(Object.entries(plan.config.services).map(([name, service]) => [name, service.image]));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const h = await dockerHarness(dir, plan.policy), expectedIdentity = runtimePolicyIdentity(plan.policy);
  const code = `import{retire}from ${JSON.stringify(new URL('../src/recovery/retire.mjs', import.meta.url).href)};await retire(${JSON.stringify(dir)},'refresh',${JSON.stringify(f.receipt.digest)},'fresh',${JSON.stringify(h.output)},false,true,${JSON.stringify({ runtime: entry.id, candidateEnrollment: true, expectedIdentity })});`;
  await exec(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, FOGD_HOME: dir, PATH: `${h.bin}:${process.env.PATH}`, FOGD_TEST_NODE: process.execPath, FOGD_TEST_DRIVER: h.driver, FOGD_TEST_LOG: h.log, FOGD_TEST_SUCCESS: '1', FOGD_TEST_STATE: join(dir, 'state.json'), FOGD_TEST_CATALOG: fileURLToPath(new URL('../src/runtime/catalog.json', import.meta.url)) } });
  const evidence = JSON.parse(await readFile(join(h.output, 'retirement.json'))), policy = JSON.parse(await readFile(h.log + '.policy'));
  assert.equal(evidence.runtimeSelection.sourceIdentitySha256, expectedIdentity);
  assert.equal(evidence.runtimeSelection.targetIdentitySha256, runtimePolicyIdentity(policy));
  assert.notEqual(evidence.runtimeSelection.targetIdentitySha256, expectedIdentity);
  assert.deepEqual(policy.fleets[0], plan.policy.fleets[0]); assert.notEqual(policy.fleets[1].prefix, plan.policy.fleets[1].prefix);
  const recovered = JSON.parse(await readFile(h.log + '.state'));
  assert.deepEqual(recovered.apps.refresh.retirement.runtimeSelection, evidence.runtimeSelection);
  assert.equal(recovered.apps.refresh.route, 'retired');
  const calls = (await readFile(h.log, 'utf8')).trim().split('\n').map(JSON.parse);
  for (const host of ['slot-2-a', 'slot-2-b']) assert.equal(calls.some(args => args.includes('tar') && args.some(arg => arg.startsWith('type=volume,src=fresh_' + host + ','))), false);
  assert.equal(calls.some(args => args[0] === 'image' && args[1] === 'load'), false);
  await assert.rejects(access(join(dir, '.fogd/installations/fresh/restore.pending.json')), { code: 'ENOENT' });
});
