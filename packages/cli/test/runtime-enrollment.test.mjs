import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prebootFixture } from './fixtures/cron-preboot.mjs';
import { freshRuntimePlan } from '../src/runtime/selection-plan.mjs';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';

const exec = promisify(execFile), cli = fileURLToPath(new URL('../bin/fogd.js', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-enrollment-')); t.after(() => rm(root, { recursive: true, force: true }));
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
    else if(args[0]==='network'&&args.includes('--filter')&&process.env.FOGD_TEST_ORPHAN)console.log('orphaned-network');
    else if(args[0]==='ps'&&args.includes('-aq')&&process.env.FOGD_TEST_CONTAINER)console.log('existing-container');
    else if(args[0]==='inspect'&&process.env.FOGD_TEST_CONTAINER)console.log(JSON.stringify([{Image:entry.image,State:{Running:false}}]));
    else if(args[0]==='volume'&&args[1]==='ls'&&process.env.FOGD_TEST_EXISTING)console.log(process.env.FOGD_TEST_EXISTING);
    else if(!['ps','volume','network'].includes(args[0]))process.exit(99);`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FOGD_HOME: root, FOGD_ENV_FILE: join(root, 'installation.env'),
    FOGD_TEST_NODE: process.execPath, FOGD_TEST_DRIVER: driver, FOGD_TEST_LOG: log,
    FOGD_TEST_SOURCE: join(root,'source.json'),
    FOGD_TEST_CATALOG: fileURLToPath(new URL('../src/runtime/catalog.json', import.meta.url)) };
  const { source } = prebootFixture();
  for (const [name, service] of Object.entries(source.services)) service.image = name === 'minio' ? 'fogd-minio:local' : 'fogd-runtime:local';
  await writeFile(env.FOGD_TEST_SOURCE, JSON.stringify(source));
  const invoke = (selection, extra = {}) => exec(process.execPath, ['--input-type=module', '-e',
    `import{selectedInstallation}from ${JSON.stringify(new URL('../src/runtime/installation.mjs', import.meta.url).href)};const selected=await selectedInstallation(${JSON.stringify(source)},${JSON.stringify(selection)});console.log(JSON.stringify(selected));`], { env: { ...env, ...extra }, timeout: 10000 });
  return { root, source, env, log, invoke };
}

test('public candidate, empty and unknown selections refuse before configuration or Docker side effects', async t => {
  const f = await fixture(t), candidate = runtimeFamilies().find(entry => entry.admission === 'candidate');
  assert.ok(candidate, 'The shipped candidate must exist for this gate');
  for (const runtime of [candidate.id, '', 'unknown-family']) {
    await assert.rejects(exec(process.execPath, [cli, 'up', `--runtime=${runtime}`], { env: f.env, timeout: 10000 }),
      error => error.code === 1 && /candidate|nonempty|Unknown shipped/.test(error.stderr));
    await assert.rejects(access(f.log), { code: 'ENOENT' });
    await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
  }
  await assert.rejects(f.invoke({ runtime: 'unknown-family', candidateEnrollment: true }), /Unknown shipped/);
  await assert.rejects(access(f.log), { code: 'ENOENT' });
});

test('existing data refuses fresh internal enrollment before writing host state', async t => {
  const f = await fixture(t), candidate = runtimeFamilies().find(entry => entry.admission === 'candidate'); assert.ok(candidate);
  await assert.rejects(f.invoke({ runtime: candidate.id, candidateEnrollment: true }, { FOGD_TEST_EXISTING: 'original_bucket' }),
    error => error.code === 1 && /Target resources already exist/.test(error.stderr));
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some(args => args[0] === 'compose'), false);
  await assert.rejects(access(join(f.root, '.fogd/installations/original')), { code: 'ENOENT' });
  await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
});

test('a failed first create durably fences the ordinary legacy fallback', async t => {
  const f = await fixture(t), candidate = runtimeFamilies().find(entry => entry.admission === 'candidate'); assert.ok(candidate);
  await assert.rejects(f.invoke({ runtime: candidate.id, candidateEnrollment: true }), error => error.code === 1 && /docker command failed \(91\)/.test(error.stderr));
  await access(join(f.root, '.fogd/installations/original/compose.json'));
  await assert.rejects(f.invoke({}), error => error.code === 1 && /runtime policy is missing/.test(error.stderr));
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(args => args[0] === 'compose').length, 1);
  assert.equal(calls.some(args => args.includes('build') || args.includes('up')), false);
  await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
});

async function calls(f) { return (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse); }

test('an existing valid independent policy selects the sealed runtime without creating services', async t => {
  const f = await fixture(t), entry = runtimeFamilies()[0], plan = freshRuntimePlan(f.source, entry);
  const policy = join(f.root, 'policy.json'); await writeFile(policy, JSON.stringify(plan.policy));
  const result = JSON.parse((await f.invoke({}, { FOGD_TEST_EXISTING: 'original_runtime-policy', FOGD_TEST_POLICY: policy })).stdout);
  assert.deepEqual(result.config, plan.config); assert.deepEqual(result.policy, plan.policy);
  assert.equal((await calls(f)).some(args => args[0] === 'compose'), false);
});

test('empty and invalid installed policies refuse with and without explicit internal selection', async t => {
  const f = await fixture(t), entry = runtimeFamilies()[0], policy = join(f.root, 'invalid-policy.json');
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
  await assert.rejects(exec(process.execPath, [cli, 'up'], { env: f.env, timeout: 10000 }),
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
  await assert.rejects(exec(process.execPath, [cli, 'tls', 'import', cert, key], { env: f.env, timeout: 10000 }),
    error => error.code === 1 && /runtime policy is missing/.test(error.stderr));
  assert.equal((await calls(f)).some(args => args[0] === 'compose' && !args.includes('config')), false);
});


test('a clean legacy project still reaches its ordinary build command', async t => {
  const f = await fixture(t);
  assert.equal(JSON.parse((await f.invoke({})).stdout), null);
  await assert.rejects(exec(process.execPath, [cli, 'up'], { env: f.env, timeout: 10000 }),
    error => error.code === 1 && /exited 91/.test(error.stderr));
  assert.ok((await calls(f)).some(args => args[0] === 'compose' && args.includes('up') && args.includes('--build')));
});
