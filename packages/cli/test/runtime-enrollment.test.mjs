import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prebootFixture } from './fixtures/cron-preboot.mjs';
import { freshRuntimePlan } from '../src/runtime/selection-plan.mjs';
import { runtimeCli } from './fixtures/runtime-cli.mjs';

const exec = promisify(execFile);
async function fixture(t, admission = 'candidate') {
  const root = await mkdtemp(join(tmpdir(), 'fogd-enrollment-')); t.after(() => rm(root, { recursive: true, force: true }));
  const client = await runtimeCli(root, admission);
  const bin = join(root, 'bin'), driver = join(root, 'docker.mjs'), log = join(root, 'calls.jsonl'); await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nexec "$FOGD_TEST_NODE" "$FOGD_TEST_DRIVER" "$@"\n', { mode: 0o700 });
  await writeFile(driver, `import{readFileSync,appendFileSync}from'node:fs';const args=process.argv.slice(2),entry=JSON.parse(readFileSync(process.env.FOGD_TEST_CATALOG))[0];appendFileSync(process.env.FOGD_TEST_LOG,JSON.stringify(args)+'\\n');
    if(args[0]==='info')console.log(JSON.stringify({OSType:'linux',Architecture:'aarch64'}));
    else if(args[0]==='image'&&args[1]==='inspect'){
      let id=args.at(-1);if(process.env.FOGD_TEST_TAG&&id==='fogd-runtime:local')id=entry.image;if(![entry.image,entry.storageImage].includes(id))process.exit(1);
      console.log(JSON.stringify([{Id:id,Os:'linux',Architecture:'arm64',Config:{WorkingDir:'/app',Env:['PATH=/usr/local/bin:/usr/bin:/bin']}}]));
    }else if(args[0]==='run'){
      const code=args.at(-1);
      if(code.includes('Runtime program must not be a symlink'))console.log(JSON.stringify({binarySha256:entry.binarySha256,supervisorSha256:entry.supervisorSha256}));
      else if(code.includes('programInventory'))console.log(JSON.stringify(entry.sourceFiles));
      else if(code.includes('readRuntimePolicy')&&process.env.FOGD_TEST_POLICY)console.log(readFileSync(process.env.FOGD_TEST_POLICY,'utf8'));
      else process.exit(98);
    }else if(args[0]==='compose'){if(args.includes('config'))console.log(readFileSync(process.env.FOGD_TEST_SOURCE,'utf8'));else process.exit(91);}
    else if(args[0]==='network'&&args[1]==='ls'&&args.length===3&&args[2]==='-q'&&process.env.FOGD_TEST_NETWORKS)console.log(JSON.parse(process.env.FOGD_TEST_NETWORKS).map(n=>n.Id).join('\\n'));
    else if(args[0]==='network'&&args[1]==='inspect'){if(process.env.FOGD_TEST_NETWORK_FAILURE)process.exit(97);console.log(process.env.FOGD_TEST_INSPECT_NETWORKS||process.env.FOGD_TEST_NETWORKS||'[]');}
    else if(args[0]==='network'&&args.includes('--filter')&&process.env.FOGD_TEST_ORPHAN)console.log('orphaned-network');
    else if(args[0]==='ps'&&args.includes('label=com.docker.compose.project='+(process.env.FOGD_TEST_RUNNING_PROJECT||'source'))&&process.env.FOGD_TEST_SOURCE_RUNNING)console.log('running-source');
    else if(args[0]==='inspect'&&args.includes('running-source'))console.log(JSON.stringify([{State:process.env.FOGD_TEST_SOURCE_RESTARTING?{Running:false,Restarting:true}:{Running:true}}]));
    else if(args[0]==='ps'&&args.includes('volume='+process.env.FOGD_TEST_WRITER_VOLUME))console.log('aliased-writer');
    else if(args[0]==='ps'&&args.includes('-aq')&&process.env.FOGD_TEST_CONTAINER)console.log('existing-container');
    else if(args[0]==='inspect'&&process.env.FOGD_TEST_CONTAINER)console.log(JSON.stringify([{Image:entry.image,State:{Running:false}}]));
    else if(args[0]==='volume'&&args[1]==='inspect')console.log(JSON.stringify(args.slice(2).map(Name=>({Name,Driver:process.env.FOGD_TEST_VOLUME_DRIVER||'local',Options:JSON.parse(process.env.FOGD_TEST_VOLUME_OPTIONS||'{}'),Labels:{'com.docker.compose.project':process.env.FOGD_TEST_FOREIGN_VOLUME?'foreign':'original','com.docker.compose.volume':process.env.FOGD_TEST_VOLUME_ROLE||Name.slice('original_'.length)}}))));
    else if(args[0]==='volume'&&args[1]==='ls'&&process.env.FOGD_TEST_EXISTING){const value=process.env.FOGD_TEST_EXISTING;const complete=value==='original_runtime-policy'&&!process.env.FOGD_TEST_EXACT_VOLUMES;console.log(complete?[...Object.values(JSON.parse(readFileSync(process.env.FOGD_TEST_SOURCE,'utf8')).volumes).map(v=>v.name),'original_runtime-policy'].join('\\n'):value);}
    else if(!['ps','volume','network'].includes(args[0]))process.exit(99);`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FOGD_HOME: root, FOGD_ENV_FILE: join(root, 'installation.env'),
    FOGD_TEST_NODE: process.execPath, FOGD_TEST_DRIVER: driver, FOGD_TEST_LOG: log,
    FOGD_TEST_SOURCE: join(root,'source.json'),
    FOGD_TEST_CATALOG: client.catalog };
  const { source } = prebootFixture();
  for (const [name, service] of Object.entries(source.services)) service.image = name === 'minio' ? 'fogd-minio:local' : 'fogd-runtime:local';
  await writeFile(env.FOGD_TEST_SOURCE, JSON.stringify(source));
  const invoke = (selection, extra = {}) => exec(process.execPath, ['--input-type=module', '-e',
    `import{selectedInstallation}from ${JSON.stringify(client.module('installation.mjs'))};const selected=await selectedInstallation(${JSON.stringify(source)},${JSON.stringify(selection)});console.log(JSON.stringify(selected));`], { env: { ...env, ...extra }, timeout: 10000 });
  return { root, source, env, log, invoke, ...client };
}

test('public candidate, empty and unknown selections refuse before configuration or Docker side effects', async t => {
  const f = await fixture(t), candidate = f.entry;
  assert.equal(candidate.admission, 'candidate');
  for (const [runtime, message] of [[candidate.id, /candidate; ordinary enrollment remains closed/], ['', /nonempty/], ['unknown-family', /Unknown shipped/]]) {
    await assert.rejects(exec(process.execPath, [f.cli, 'up', `--runtime=${runtime}`], { env: f.env, timeout: 10000 }),
      error => error.code === 1 && message.test(error.stderr));
    await assert.rejects(access(f.log), { code: 'ENOENT' });
    await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
  }
  await assert.rejects(f.invoke({ runtime: 'unknown-family', candidateEnrollment: true }), /Unknown shipped/);
  await assert.rejects(access(f.log), { code: 'ENOENT' });
});

test('existing data refuses fresh internal enrollment before writing host state', async t => {
  const f = await fixture(t), candidate = f.entry; assert.ok(candidate);
  await assert.rejects(f.invoke({ runtime: candidate.id, candidateEnrollment: true }, { FOGD_TEST_EXISTING: 'original_bucket' }),
    error => error.code === 1 && /Target resources already exist/.test(error.stderr));
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some(args => args[0] === 'compose'), false);
  await assert.rejects(access(join(f.root, '.fogd/installations/original')), { code: 'ENOENT' });
  await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
});

const networks = { control: '10.253.180.0/24', 'fleet-1': '10.253.181.0/24', 'fleet-2': '10.253.182.0/24' };
const occupied = subnet => JSON.stringify([{ Id: 'a'.repeat(64), IPAM: { Config: [{ Subnet: subnet }] } }]);
test('public qualified startup reads the plan and inventories Docker before create', async t => {
  const f = await fixture(t, 'qualified'), file = join(f.root, 'networks.json'); await writeFile(file, JSON.stringify(networks));
  await assert.rejects(exec(process.execPath, [f.cli, 'up', '--runtime', f.entry.id, '--network-plan', file], { env: { ...f.env, FOGD_TEST_NETWORKS: occupied('172.17.0.0/16') } }), /docker command failed \(91\)/);
  const recorded = await calls(f), inspect = recorded.findIndex(args => args[0] === 'network' && args[1] === 'inspect'), create = recorded.findIndex(args => args[0] === 'compose' && args.includes('create'));
  assert.ok(inspect >= 0 && create > inspect);
  const config = JSON.parse(await readFile(join(f.root, '.fogd/installations/original/compose.json')));
  assert.deepEqual(config.networks.control.ipam.config, [{ subnet: networks.control }]);
});
for (const [networkInventory, inspection] of [
  [JSON.stringify([{ Id: 'private-invalid-id' }]), undefined],
  [occupied('172.17.0.0/16'), '[]'],
  [occupied('172.17.0.0/16'), JSON.stringify([{ Id: 'b'.repeat(64), IPAM: { Config: [] } }])],
]) test('malformed or incomplete Docker network inventory refuses without an enrollment fence', async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke({ runtime: f.entry.id, candidateEnrollment: true, networks }, { FOGD_TEST_NETWORKS: networkInventory, ...(inspection ? { FOGD_TEST_INSPECT_NETWORKS: inspection } : {}) }), /Cannot verify Docker network inventory|inspection did not cover/);
  await assert.rejects(access(join(f.root, '.fogd/installations/original')), { code: 'ENOENT' });
  assert.equal((await calls(f)).some(args => args[0] === 'compose'), false);
});

test('explicit maintenance resolves only the enrolled configuration and requires every retained volume', async t => {
  const f = await fixture(t), plan = freshRuntimePlan(f.source, f.entry), directory = join(f.root, '.fogd/installations/original');
  await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(join(directory, 'compose.json'), JSON.stringify(plan.config), { mode: 0o600 });
  const code = `import{maintenanceConfiguration}from ${JSON.stringify(f.module('maintenance.mjs'))};console.log(JSON.stringify(await maintenanceConfiguration({FOGD_COMPOSE_FILE:'/private/wrong-template'},'original')));`;
  const env = { ...f.env, FOGD_TEST_EXISTING: Object.values(plan.config.volumes).map(volume => volume.name).join('\n') };
  assert.deepEqual(JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', code], { env })).stdout), plan.config);
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code], { env: { ...env, FOGD_TEST_EXISTING: 'original_runtime-policy', FOGD_TEST_EXACT_VOLUMES: '1' } }), /storage is incomplete/);
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code], { env: { ...env, FOGD_TEST_FOREIGN_VOLUME: '1' } }), /not owned local project storage/);
  assert.equal((await calls(f)).some(args => args[0] === 'compose'), false);
  await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
});
test('explicit backup cannot fall back from an unknown installation to the profile template', async t => {
  const f = await fixture(t), output = join(f.root, 'must-not-exist');
  await assert.rejects(exec(process.execPath, [f.cli, 'backup', output, '--installation', 'missing'], { env: f.env }), /Cannot read the enrolled installation configuration/);
  await assert.rejects(access(output), { code: 'ENOENT' }); await assert.rejects(access(f.log), { code: 'ENOENT' });
});
test('explicit certificate import cannot bootstrap the profile or fall back from an unknown installation', async t => {
  const f = await fixture(t), cert = join(f.root, 'cert.pem'), key = join(f.root, 'key.pem');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost']);
  await assert.rejects(exec(process.execPath, [f.cli, 'tls', 'import', cert, key, '--installation', 'missing'], { env: f.env }), /Cannot read the enrolled installation configuration/);
  await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' }); await assert.rejects(access(f.log), { code: 'ENOENT' });
});
test('fresh selected enrollment checks Docker overlap before creating its durable fence or containers', async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke({ runtime: f.entry.id, candidateEnrollment: true, networks }, { FOGD_TEST_NETWORKS: occupied('10.253.0.0/16') }), /overlaps an existing Docker subnet/);
  await assert.rejects(access(join(f.root, '.fogd/installations/original')), { code: 'ENOENT' });
  assert.equal((await calls(f)).some(args => args[0] === 'compose'), false);
});
test('unreadable Docker network inventory refuses before enrollment writes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke({ runtime: f.entry.id, candidateEnrollment: true, networks }, { FOGD_TEST_NETWORKS: occupied('172.17.0.0/16'), FOGD_TEST_NETWORK_FAILURE: '1' }), /docker command failed \(97\)/);
  await assert.rejects(access(join(f.root, '.fogd/installations/original')), { code: 'ENOENT' });
  assert.equal((await calls(f)).some(args => args[0] === 'compose'), false);
});
test('unused explicit subnets reach create with the plan sealed into the saved configuration', async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke({ runtime: f.entry.id, candidateEnrollment: true, networks }, { FOGD_TEST_NETWORKS: occupied('172.17.0.0/16') }), /docker command failed \(91\)/);
  const config = JSON.parse(await readFile(join(f.root, '.fogd/installations/original/compose.json')));
  assert.deepEqual(Object.fromEntries(Object.entries(config.networks).map(([name, value]) => [name, value.ipam.config[0].subnet])), networks);
  assert.equal((await calls(f)).filter(args => args[0] === 'compose').length, 1);
});
test('installed startup accepts only its original network plan and skips overlap checks against its own networks', async t => {
  const f = await fixture(t), plan = freshRuntimePlan(f.source, f.entry, networks), policy = join(f.root, 'policy.json');
  await writeFile(policy, JSON.stringify(plan.policy));
  const selection = { runtime: f.entry.id, candidateEnrollment: true, networks };
  const extra = { FOGD_TEST_EXISTING: 'original_runtime-policy', FOGD_TEST_POLICY: policy, FOGD_TEST_NETWORKS: occupied(networks.control) };
  const result = JSON.parse((await f.invoke(selection, extra)).stdout);
  assert.deepEqual(result.policy, plan.policy);
  const file = join(f.root, '.fogd/installations/original/compose.json'), before = await readFile(file);
  await assert.rejects(f.invoke({ ...selection, networks: { ...networks, control: '10.253.183.0/24' } }, extra), /Network plan differs from the installed policy/);
  assert.deepEqual(await readFile(file), before);
  assert.equal((await calls(f)).some(args => args[0] === 'network' && args[1] === 'inspect'), false);
  assert.equal((await calls(f)).some(args => args[0] === 'compose'), false);
});

test('a failed first create durably fences the ordinary legacy fallback', async t => {
  const f = await fixture(t), candidate = f.entry; assert.ok(candidate);
  await assert.rejects(f.invoke({ runtime: candidate.id, candidateEnrollment: true }), error => error.code === 1 && /docker command failed \(91\)/.test(error.stderr));
  await access(join(f.root, '.fogd/installations/original/compose.json'));
  await assert.rejects(f.invoke({}), error => error.code === 1 && /runtime policy is missing/.test(error.stderr));
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args[0] === 'compose').length, 1);
  assert.equal(calls.some(args => args.includes('build') || args.includes('up')), false);
  await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
});

async function calls(f) { return (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse); }

async function recordRecovery(f, project, sourceProject) {
  const directory = join(f.root, '.fogd/installations', project); await mkdir(directory, { recursive: true, mode: 0o700 });
  const config = freshRuntimePlan(f.source, f.entry).config; config.name = project;
  for (const [name, volume] of Object.entries(config.volumes)) volume.name = `${project}_${name}`;
  for (const [name, network] of Object.entries(config.networks)) network.name = `${project}_${name}`;
  await writeFile(join(directory, 'compose.json'), JSON.stringify(config), { mode: 0o600 });
  await writeFile(join(directory, 'recovery-source.json'), JSON.stringify({ schema: 1, project, sourceProject,
    volumes: Object.keys(config.volumes).sort().map(name => `${sourceProject}_${name}`) }), { mode: 0o600 });
  return directory;
}

test('an existing valid independent policy selects the sealed runtime without creating services', async t => {
  const f = await fixture(t), entry = f.entry, plan = freshRuntimePlan(f.source, entry);
  const policy = join(f.root, 'policy.json'); await writeFile(policy, JSON.stringify(plan.policy));
  const result = JSON.parse((await f.invoke({}, { FOGD_TEST_EXISTING: 'original_runtime-policy', FOGD_TEST_POLICY: policy })).stdout);
  assert.deepEqual(result.config, plan.config); assert.deepEqual(result.policy, plan.policy);
  assert.equal((await calls(f)).some(args => args[0] === 'compose'), false);
});

test('empty and invalid installed policies refuse with and without explicit internal selection', async t => {
  const f = await fixture(t), entry = f.entry, policy = join(f.root, 'invalid-policy.json');
  for (const data of ['', '{}']) {
    await writeFile(policy, data);
    for (const selection of [{}, { runtime: entry.id, candidateEnrollment: true }]) {
      await assert.rejects(f.invoke(selection, { FOGD_TEST_EXISTING: 'original_runtime-policy', FOGD_TEST_POLICY: policy }),
        error => error.code === 1 && /policy|Policy/.test(error.stderr));
    }
  }
  assert.equal((await calls(f)).some(args => args[0] === 'compose'), false);
});

test('catalog containers and orphaned project networks refuse a missing policy across checkouts', async t => {
  for (const extra of [{ FOGD_TEST_CONTAINER: '1' }, { FOGD_TEST_ORPHAN: '1' }, { FOGD_TEST_TAG: '1' }]) {
    const f = await fixture(t);
    await assert.rejects(f.invoke({}, extra), error => error.code === 1 && /runtime policy is missing/.test(error.stderr));
    assert.equal((await calls(f)).some(args => args[0] === 'compose'), false);
  }
});

test('ordinary CLI up refuses a durable enrollment fence before any compose mutation', async t => {
  const f = await fixture(t); await mkdir(join(f.root, '.fogd/installations/original'), { recursive: true });
  await assert.rejects(exec(process.execPath, [f.cli, 'up'], { env: f.env, timeout: 10000 }),
    error => error.code === 1 && /runtime policy is missing/.test(error.stderr));
  const invoked = await calls(f);
  assert.ok(invoked.some(args => args[0] === 'compose' && args.includes('config')));
  assert.equal(invoked.some(args => args[0] === 'compose' && !args.includes('config')), false);
});

test('ordinary CLI TLS import refuses a durable fence before build or create', async t => {
  const f = await fixture(t), cert = join(f.root, 'cert.pem'), key = join(f.root, 'key.pem');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost']);
  f.source.volumes.tls = { name: 'original_tls' };
  for (const name of ['controller', 'workerd']) (f.source.services[name].volumes ||= []).push({ type: 'volume', source: 'tls', target: '/var/lib/fogd-tls', read_only: true });
  await writeFile(f.env.FOGD_TEST_SOURCE, JSON.stringify(f.source));
  await mkdir(join(f.root, '.fogd/installations/original'), { recursive: true });
  await assert.rejects(exec(process.execPath, [f.cli, 'tls', 'import', cert, key], { env: f.env, timeout: 10000 }),
    error => error.code === 1 && /runtime policy is missing/.test(error.stderr));
  assert.equal((await calls(f)).some(args => args[0] === 'compose' && !args.includes('config')), false);
});


test('a clean legacy project still reaches its ordinary build command', async t => {
  const f = await fixture(t);
  assert.equal(JSON.parse((await f.invoke({})).stdout), null);
  await assert.rejects(exec(process.execPath, [f.cli, 'up'], { env: f.env, timeout: 10000 }),
    error => error.code === 1 && /exited 91/.test(error.stderr));
  assert.ok((await calls(f)).some(args => args[0] === 'compose' && args.includes('up') && args.includes('--build')));
});

test('ordinary installation startup uses the existing policy and pinned no-build path without writing credentials', async t => {
  const f = await fixture(t), entry = f.entry, plan = freshRuntimePlan(f.source, entry), policy = join(f.root, 'policy.json');
  await writeFile(policy, JSON.stringify(plan.policy));
  const directory = join(f.root, '.fogd/installations/original'); await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'compose.json'), JSON.stringify(plan.config), { mode: 0o600 });
  await assert.rejects(exec(process.execPath, [f.cli, 'up', '--installation', 'original'], { env: { ...f.env, FOGD_TEST_EXISTING: 'original_runtime-policy', FOGD_TEST_POLICY: policy }, timeout: 10000 }),
    error => error.code === 1 && /docker command failed \(91\)/.test(error.stderr));
  const launch = (await calls(f)).filter(args => args[0] === 'compose');
  assert.equal(launch.length, 1); assert.deepEqual(launch[0].slice(-5), ['up', '-d', '--no-build', '--pull', 'never']);
  assert.equal(launch[0].includes('--build'), false);
  await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
});

for (const mode of ['enrolled', 'selector']) test(`${mode} startup refuses missing or foreign installation storage before configuration writes or container mutation`, async t => {
  const f = await fixture(t, 'qualified'), plan = freshRuntimePlan(f.source, f.entry), policy = join(f.root, 'policy.json');
  await writeFile(policy, JSON.stringify(plan.policy));
  const directory = join(f.root, '.fogd/installations/original'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'compose.json'); await writeFile(file, JSON.stringify(plan.config), { mode: 0o600 });
  const before = await readFile(file);
  const args = mode === 'enrolled' ? ['up', '--installation', 'original'] : ['up', '--runtime', f.entry.id];
  const env = { ...f.env, FOGD_TEST_POLICY: policy, FOGD_TEST_EXACT_VOLUMES: '1', FOGD_ADMIN_PASSWORD: 'private-admin', FOGD_GATEWAY_TOKEN: 'private-gateway', FOGD_DEPLOY_TOKEN: 'private-deploy' };
  const names = Object.values(plan.config.volumes).map(volume => volume.name);
  await assert.rejects(exec(process.execPath, [f.cli, ...args], { env: { ...env, FOGD_TEST_EXISTING: names.filter(name => name !== 'original_bucket').join('\n') } }), /storage is incomplete/);
  await assert.rejects(exec(process.execPath, [f.cli, ...args], { env: { ...env, FOGD_TEST_EXISTING: names.join('\n'), FOGD_TEST_FOREIGN_VOLUME: '1' } }), /not owned local project storage/);
  assert.deepEqual(await readFile(file), before);
  assert.equal((await calls(f)).some(args => args[0] === 'compose' && args.some(value => ['up', 'create', 'build'].includes(value))), false);
});


test('an enrolled recovery target refuses startup while its recorded local source is running', async t => {
  const f = await fixture(t), plan = freshRuntimePlan(f.source, f.entry), directory = join(f.root, '.fogd/installations/original');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'compose.json'), JSON.stringify(plan.config), { mode: 0o600 });
  await writeFile(join(directory, 'recovery-source.json'), JSON.stringify({ schema: 1, project: 'original', sourceProject: 'source', volumes: ['source_bucket'] }), { mode: 0o600 });
  await assert.rejects(exec(process.execPath, [f.cli, 'up', '--installation', 'original'], { env: { ...f.env, FOGD_TEST_SOURCE_RUNNING: '1' }, timeout: 10000 }), error => /Project still has running containers/.test(error.stderr));
  assert.equal((await calls(f)).some(args => ['compose', 'run', 'image'].includes(args[0])), false);
  await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
});

test('a repeated explicit fresh enrollment retains the earlier failed-create fence', async t => {
  const f = await fixture(t), selection = { runtime: f.entry.id, candidateEnrollment: true };
  await assert.rejects(f.invoke(selection), error => /command failed \(91\)/.test(error.stderr));
  const path = join(f.root, '.fogd/installations/original/compose.json'), before = await readFile(path, 'utf8');
  await assert.rejects(f.invoke(selection), error => /enrollment already exists/.test(error.stderr));
  assert.equal(await readFile(path, 'utf8'), before);
  assert.equal((await calls(f)).filter(args => args[0] === 'compose').length, 1);
});


test('recorded recovery relationships exclude running descendants, siblings, chains and restarting sources', async t => {
  for (const [records, running, restarting] of [
    [[['target', 'original']], 'target', false],
    [[['original', 'source'], ['target', 'source']], 'target', false],
    [[['original', 'middle'], ['middle', 'source'], ['target', 'source']], 'target', false],
    [[['original', 'source']], 'source', true],
  ]) {
    const f = await fixture(t);
    for (const [project, sourceProject] of records) await recordRecovery(f, project, sourceProject);
    await assert.rejects(f.invoke({}, { FOGD_TEST_SOURCE_RUNNING: '1', FOGD_TEST_RUNNING_PROJECT: running, ...(restarting ? { FOGD_TEST_SOURCE_RESTARTING: '1' } : {}) }), error => /Project still has running containers/.test(error.stderr));
    assert.equal((await calls(f)).some(args => ['run', 'compose', 'image'].includes(args[0])), false);
    await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
  }
});


test('a running recorded installation outside the recovery family does not block a clean legacy project', async t => {
  const f = await fixture(t), directory = join(f.root, '.fogd/installations/other'); await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'recovery-source.json'), JSON.stringify({ schema: 1, project: 'other', sourceProject: 'unrelated', volumes: ['unrelated_bucket'] }), { mode: 0o600 });
  const result = await f.invoke({}, { FOGD_TEST_SOURCE_RUNNING: '1', FOGD_TEST_RUNNING_PROJECT: 'other' });
  assert.equal(JSON.parse(result.stdout), null);
  assert.equal((await calls(f)).some(args => args.includes('label=com.docker.compose.project=other')), false);
});

test('startup refuses aliased writers on restored sibling and descendant volumes', async t => {
  for (const [records, volumes] of [
    [[['original', 'source'], ['sibling', 'source']], ['sibling_bucket', 'sibling_controller', 'sibling_slot-1-a', 'sibling_slot-1-b', 'sibling_slot-2-a', 'sibling_slot-2-b', 'sibling_runtime-policy']],
    [[['descendant', 'original']], ['descendant_bucket']],
    [[['middle', 'original'], ['descendant', 'middle']], ['descendant_bucket']],
  ]) {
    const f = await fixture(t), plan = freshRuntimePlan(f.source, f.entry), policy = join(f.root, 'policy.json');
    await writeFile(policy, JSON.stringify(plan.policy));
    for (const [project, sourceProject] of records) await recordRecovery(f, project, sourceProject);
    for (const volume of volumes) {
      await assert.rejects(f.invoke({}, { FOGD_TEST_WRITER_VOLUME: volume, FOGD_TEST_EXISTING: 'original_runtime-policy', FOGD_TEST_POLICY: policy }), error => /snapshot volume still has a running writer/.test(error.stderr));
    }
    assert.equal((await calls(f)).some(args => ['run', 'compose', 'image'].includes(args[0])), false);
  }
});

test('recovery exclusion permits the current installation to use its own volumes', async t => {
  const f = await fixture(t), plan = freshRuntimePlan(f.source, f.entry), policy = join(f.root, 'policy.json');
  await writeFile(policy, JSON.stringify(plan.policy));
  for (const project of ['original', 'sibling']) await recordRecovery(f, project, 'source');
  const result = JSON.parse((await f.invoke({}, { FOGD_TEST_WRITER_VOLUME: 'original_bucket', FOGD_TEST_EXISTING: 'original_runtime-policy', FOGD_TEST_POLICY: policy })).stdout);
  assert.deepEqual(result.config, plan.config);
});

test('a stopped incomplete sibling does not prevent using the current installation', async t => {
  const f = await fixture(t), plan = freshRuntimePlan(f.source, f.entry), policy = join(f.root, 'policy.json');
  await writeFile(policy, JSON.stringify(plan.policy));
  await recordRecovery(f, 'original', 'source');
  const sibling = await recordRecovery(f, 'sibling', 'source'), pending = join(sibling, 'restore.pending.json');
  await writeFile(pending, '{}', { mode: 0o600 });
  const result = JSON.parse((await f.invoke({}, { FOGD_TEST_EXISTING: 'original_runtime-policy', FOGD_TEST_POLICY: policy })).stdout);
  assert.deepEqual(result.config, plan.config);
  assert.equal(await readFile(pending, 'utf8'), '{}');
});

test('an enrolled root source checks volumes added after the recorded snapshot', async t => {
  const f = await fixture(t);
  await recordRecovery(f, 'original', 'source');
  const source = await recordRecovery(f, 'source', 'unused'), file = join(source, 'compose.json');
  await rm(join(source, 'recovery-source.json'));
  const config = JSON.parse(await readFile(file, 'utf8')); config.volumes.tls = { name: 'source_tls' };
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  await assert.rejects(f.invoke({}, { FOGD_TEST_WRITER_VOLUME: 'source_tls' }), error => /snapshot volume still has a running writer/.test(error.stderr));
  assert.equal((await calls(f)).some(args => ['run', 'compose', 'image'].includes(args[0])), false);
});

test('related installations with missing or malformed volume configuration refuse before runtime effects', async t => {
  for (const content of [null, '{private-value', '{"name":"sibling","volumes":{}}']) {
    const f = await fixture(t);
    await recordRecovery(f, 'original', 'source');
    const sibling = await recordRecovery(f, 'sibling', 'source'), file = join(sibling, 'compose.json');
    if (content === null) await rm(file);
    else await writeFile(file, content, { mode: 0o600 });
    await assert.rejects(f.invoke({}), error => /Related installation sibling is not confirmed stopped/.test(error.stderr) && !/private-value/.test(error.stderr));
    assert.equal((await calls(f)).some(args => ['run', 'compose', 'image'].includes(args[0])), false);
  }
});

test('recovery source publication refuses replacement and cleans the staged file', async t => {
  const f = await fixture(t), state = new URL('../src/runtime/installation-state.mjs', import.meta.url).href, source = new URL('../src/runtime/recovery-source.mjs', import.meta.url).href;
  const code = `import{writeRuntimeConfiguration}from ${JSON.stringify(state)};import{writeRecoverySource}from ${JSON.stringify(source)};await writeRuntimeConfiguration({name:'target'},{reserve:true,recovery:true});await writeRecoverySource('target','original',${JSON.stringify(f.source)});await writeRecoverySource('target','other',${JSON.stringify(f.source)});`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code], { env: f.env }), error => /EEXIST/.test(error.stderr));
  const directory = join(f.root, '.fogd/installations/target');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'recovery-source.json'))), { schema: 1, project: 'target', sourceProject: 'original', volumes: Object.keys(f.source.volumes).sort().map(name => f.source.volumes[name].name) });
  const list = (await import('node:fs/promises')).readdir;
  assert.deepEqual((await list(directory)).filter(name => name.startsWith('recovery-source-')), []);
});

for (const [label, metadata] of [
  ['foreign project', { FOGD_TEST_FOREIGN_VOLUME: '1' }],
  ['foreign role', { FOGD_TEST_VOLUME_ROLE: 'bucket' }],
  ['external driver', { FOGD_TEST_VOLUME_DRIVER: 'external-driver' }],
  ['local mount options', { FOGD_TEST_VOLUME_OPTIONS: '{"device":"/private/foreign"}' }],
]) test(`policy volume with ${label} refuses before any reader or installation mutation`, async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke({ runtime: f.entry.id, candidateEnrollment: true }, { FOGD_TEST_EXISTING: 'original_runtime-policy', ...metadata }), /not owned local project storage/);
  const recorded = await calls(f);
  assert.deepEqual(recorded.map(args => args.slice(0, 2)), [['volume', 'ls'], ['volume', 'inspect']]);
  await assert.rejects(access(join(f.root, '.fogd/installations/original')), { code: 'ENOENT' });
  await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
});

test('two-source publication is atomic and refuses replacement while excluding each source from startup', async t => {
  const f = await fixture(t), state = new URL('../src/runtime/installation-state.mjs', import.meta.url).href, source = new URL('../src/runtime/recovery-source.mjs', import.meta.url).href;
  const code = `import{writeRuntimeConfiguration}from ${JSON.stringify(state)};import{writeRecoverySources}from ${JSON.stringify(source)};await writeRuntimeConfiguration({...${JSON.stringify(f.source)},name:'original'},{reserve:true});await writeRecoverySources('original',[{project:'current',config:${JSON.stringify(f.source)}},{project:'retained',config:${JSON.stringify(f.source)}}]);`;
  await exec(process.execPath, ['--input-type=module', '-e', code], { env: f.env });
  const directory = join(f.root, '.fogd/installations/original'), before = await readFile(join(directory, 'recovery-source.json'));
  assert.deepEqual(JSON.parse(before).sources.map(source => source.sourceProject), ['current', 'retained']);
  for (const name of ['current', 'retained']) await assert.rejects(f.invoke({}, { FOGD_TEST_SOURCE_RUNNING: '1', FOGD_TEST_RUNNING_PROJECT: name }), /Project still has running containers/);
  const replace = `import{writeRecoverySources}from ${JSON.stringify(source)};await writeRecoverySources('original',[{project:'other',config:${JSON.stringify(f.source)}},{project:'retained',config:${JSON.stringify(f.source)}}]);`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', replace], { env: f.env }), /EEXIST/);
  assert.deepEqual(await readFile(join(directory, 'recovery-source.json')), before);
  const list = (await import('node:fs/promises')).readdir;
  assert.deepEqual((await list(directory)).filter(name => name.startsWith('recovery-source-')), []);
});
test('two-source recovery graph excludes a running sibling reached through its other source', async t => {
  const f = await fixture(t), state = new URL('../src/runtime/installation-state.mjs', import.meta.url).href, source = new URL('../src/runtime/recovery-source.mjs', import.meta.url).href;
  const code = `import{writeRuntimeConfiguration}from ${JSON.stringify(state)};import{writeRecoverySources,writeRecoverySource,assertRecoverySourceStopped}from ${JSON.stringify(source)};const c=${JSON.stringify(f.source)};await writeRuntimeConfiguration({...c,name:'target'},{reserve:true});await writeRuntimeConfiguration({...c,name:'sibling'},{reserve:true});await writeRecoverySources('target',[{project:'current',config:c},{project:'retained',config:c}]);await writeRecoverySource('sibling','current',c);await assertRecoverySourceStopped('retained');`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code], { env: { ...f.env, FOGD_TEST_SOURCE_RUNNING: '1', FOGD_TEST_RUNNING_PROJECT: 'sibling' } }), /Related installation sibling is not confirmed stopped/);
  assert.equal((await calls(f)).some(args => ['run', 'compose', 'image'].includes(args[0])), false);
});
test('duplicate source projects refuse before publishing any multi-source record', async t => {
  const f = await fixture(t), state = new URL('../src/runtime/installation-state.mjs', import.meta.url).href, source = new URL('../src/runtime/recovery-source.mjs', import.meta.url).href;
  const code = `import{writeRuntimeConfiguration}from ${JSON.stringify(state)};import{writeRecoverySources}from ${JSON.stringify(source)};await writeRuntimeConfiguration({...${JSON.stringify(f.source)},name:'target'},{reserve:true});await writeRecoverySources('target',[{project:'same',config:${JSON.stringify(f.source)}},{project:'same',config:${JSON.stringify(f.source)}}]);`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', code], { env: f.env }), /Invalid recovery source exclusion record/);
  await assert.rejects(access(join(f.root, '.fogd/installations/target/recovery-source.json')), { code: 'ENOENT' });
});
