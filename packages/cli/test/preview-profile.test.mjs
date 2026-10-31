import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, readdir, readFile, writeFile, rm, stat, chmod, cp, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializePreviewProfile, readPreviewProfile, inspectPreviewProfile } from '../src/preview/profile.mjs';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import { acquirePreviewHost } from '../src/preview/host-registry.mjs';
import { previewStorageWorkerSha256 } from '../src/preview/storage.mjs';
import { emptyPreviewDocker } from './fixtures/preview-host.mjs';
import { previewStorageAdmissionFixture } from './fixtures/preview-storage.mjs';

const refused = { code: 'PREVIEW_PROFILE_REFUSED' }, exec = promisify(execFile), bin = new URL('../bin/fogd.js', import.meta.url).pathname;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fogd-profile-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const docker = emptyPreviewDocker(), calls = [], input = { output: join(root, 'profile'), dockerContext: 'owned-profile', storageRoot: '/var/lib/docker/owned-preview', maxProjects: 2, run: docker.run };
  let initialized = false, report = previewStorageAdmissionFixture({ root: input.storageRoot, engineId: docker.host.ID });
  input.runHost = async (args, options) => {
    assert.equal(hash(args[2]), previewStorageWorkerSha256); const request = JSON.parse(options.inputText); calls.push(request);
    if (request.action === 'initialize') {
      assert.ok(await readFile(join(input.output, 'profile.initialization.json')));
      if (initialized) return JSON.stringify({ ok: false, reason: 'uncertain' });
      initialized = true; report = previewStorageAdmissionFixture({ root: request.root, engineId: request.engineId }, request.maxProjects);
    }
    return JSON.stringify({ ok: true, admission: report });
  };
  const inspect = receipt => inspectPreviewProfile({ directory: receipt.directory, expectedProfileSha256: receipt.profileSha256, run: docker.run, runHost: input.runHost });
  return { root, docker, calls, input, inspect, get report() { return report; } };
}

test('fresh profile binds one private ledger and storage policy without runtime or capacity permission', async t => {
  const f = await fixture(t), receipt = await initializePreviewProfile(f.input), profile = await readPreviewProfile(receipt.directory, receipt.profileSha256);
  assert.equal(profile.root, join(receipt.directory, 'ledger')); assert.equal(profile.engineId, f.docker.host.ID);
  assert.equal(hash(await readFile(join(receipt.directory, 'profile.json'))), receipt.profileSha256);
  assert.equal(receipt.runtimeStarted, false); assert.equal(receipt.executionAuthorized, false);
  for (const name of ['profile.json', 'profile.initialization.json', 'profile.complete.json']) assert.equal((await stat(join(receipt.directory, name))).mode & 0o7777, 0o600);
  assert.equal((await stat(receipt.directory)).mode & 0o7777, 0o700);
  const status = await f.inspect(receipt);
  assert.equal(status.activeMemoryReservations, 0); assert.equal(status.heldStorageProjects, 0); assert.equal(status.remainingStorageProjects, 2);
  assert.equal(status.executionAuthorized, false); assert.equal(status.storageAdmissionOpen, true);
  assert.deepEqual(f.calls.map(value => value.action), ['initialize', 'admission', 'admission']);
  assert.ok(f.docker.calls.every(args => ['info', 'container', 'volume', 'network'].includes(args[0])));
  assert.ok(!(await readdir(join(profile.root, hash(profile.engineId)))).includes('launch.pending.json'));
});

test('existing output cannot repeat initialization or overwrite a completed profile', async t => {
  const f = await fixture(t), receipt = await initializePreviewProfile(f.input), original = await readFile(join(receipt.directory, 'profile.json')), calls = f.calls.length;
  await assert.rejects(initializePreviewProfile(f.input), refused); assert.equal(f.calls.length, calls);
  assert.deepEqual(await readFile(join(receipt.directory, 'profile.json')), original);
});

test('an unknown storage initialization result preserves intent and cannot be replayed through the same output', async t => {
  const f = await fixture(t); let calls = 0;
  f.input.runHost = async () => { calls++; throw Error('PRIVATE_HOST_DIAGNOSTIC'); };
  await assert.rejects(initializePreviewProfile(f.input), error => error.code === refused.code && !error.message.includes('PRIVATE_'));
  assert.deepEqual(await readdir(f.input.output), ['profile.initialization.json']);
  const intent = await readFile(join(f.input.output, 'profile.initialization.json'));
  await assert.rejects(initializePreviewProfile(f.input), refused); assert.equal(calls, 1);
  assert.deepEqual(await readFile(join(f.input.output, 'profile.initialization.json')), intent);
  await assert.rejects(readPreviewProfile(f.input.output, hash(intent)), refused);
});

test('invalid targets and unsupported engines refuse before creating output or calling storage', async t => {
  const f = await fixture(t);
  for (const extra of [{ maxProjects: 0 }, { maxProjects: '2' }, { dockerContext: '--host=foreign' }, { storageRoot: '/var/lib/../other' }]) await assert.rejects(initializePreviewProfile({ ...f.input, ...extra }), refused);
  f.docker.host.OSType = 'other'; await assert.rejects(initializePreviewProfile(f.input), refused);
  assert.deepEqual(f.calls, []); await assert.rejects(stat(f.input.output), { code: 'ENOENT' });
});

for (const [name, change] of Object.entries({
  changedProfile: async (f, r) => writeFile(join(r.directory, 'profile.json'), '{}\n'),
  missingCompletion: async (f, r) => unlink(join(r.directory, 'profile.complete.json')),
  changedIntent: async (f, r) => writeFile(join(r.directory, 'profile.initialization.json'), '{}\n'),
  publicMetadata: async (f, r) => chmod(join(r.directory, 'profile.complete.json'), 0o644),
  unknownMember: async (f, r) => writeFile(join(r.directory, 'unknown.json'), '{}\n'),
  relocation: async (f, r) => { const moved = join(f.root, 'moved'); await cp(r.directory, moved, { recursive: true }); return moved; },
})) test(`profile ${name} refuses before engine or host observation`, async t => {
  const f = await fixture(t), receipt = await initializePreviewProfile(f.input), directory = await change(f, receipt) || receipt.directory;
  f.calls.length = 0; f.docker.calls.length = 0;
  await assert.rejects(inspectPreviewProfile({ directory, expectedProfileSha256: receipt.profileSha256, run: f.docker.run, runHost: f.input.runHost }), refused);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.docker.calls, []);
});

test('status refuses a changed engine or policy, preserves the profile and releases only its checking fence', async t => {
  const f = await fixture(t), receipt = await initializePreviewProfile(f.input), profile = await readPreviewProfile(receipt.directory, receipt.profileSha256);
  const original = await readFile(join(receipt.directory, 'profile.json'));
  f.docker.host.ID = 'different-engine'; await assert.rejects(f.inspect(receipt), refused); f.docker.host.ID = profile.engineId;
  f.report.policy.id = '00000000-0000-4000-8000-000000000009'; await assert.rejects(f.inspect(receipt), refused);
  assert.deepEqual(await readFile(join(receipt.directory, 'profile.json')), original);
  assert.ok(!(await readdir(join(profile.root, hash(profile.engineId)))).includes('launch.pending.json'));
});

test('real CLI initializes and inspects through explicit sanitized Docker/SSH transports without candidate permission', async t => {
  const f = await fixture(t), tools = join(f.root, 'tools'), state = join(f.root, 'admission.json'), calls = join(f.root, 'calls.jsonl'); await mkdir(tools);
  const record = `await appendFile(${JSON.stringify(calls)},JSON.stringify({args:process.argv.slice(2),ambient:Object.keys(process.env).filter(k=>k.startsWith('FOGD_')||k.startsWith('DOCKER_'))})+'\\n');`;
  await writeFile(join(tools, 'docker'), `#!${process.execPath}\nimport{appendFile}from'node:fs/promises';${record}const args=process.argv.slice(2);if(args[0]!=='--context'||args[1]!=='owned-profile')process.exit(3);if(args[2]==='info')console.log(${JSON.stringify(JSON.stringify(f.docker.host))});else if(args[3]==='ls')console.log('');else process.exit(4);`, { mode: 0o700 });
  await writeFile(join(tools, 'ssh'), `#!${process.execPath}\nimport{readFile,writeFile,appendFile}from'node:fs/promises';${record}let raw='';for await(const chunk of process.stdin)raw+=chunk;const request=JSON.parse(JSON.parse(raw).input);if(request.action==='initialize')await writeFile(${JSON.stringify(state)},${JSON.stringify(JSON.stringify(f.report))},{flag:'wx'});console.log(JSON.stringify({ok:true,admission:JSON.parse(await readFile(${JSON.stringify(state)}))}));`, { mode: 0o700 });
  const env = { ...process.env, PATH: tools, FOGD_ADMIN_PASSWORD: 'PRIVATE_SOURCE_PASSWORD', DOCKER_HOST: 'tcp://wrong-host' };
  const init = [bin, 'preview', 'profile', 'init', '--docker-context', 'owned-profile', '--storage-host', 'owned-linux', '--storage-root', f.input.storageRoot, '--max-projects', '2', '--output', f.input.output];
  const receipt = JSON.parse((await exec(process.execPath, init, { env })).stdout);
  const status = JSON.parse((await exec(process.execPath, [bin, 'preview', 'profile', 'status', receipt.directory, '--expected-profile', receipt.profileSha256, '--storage-host', 'owned-linux'], { env })).stdout);
  assert.equal(status.remainingStorageProjects, 2); assert.equal(status.executionAuthorized, false);
  assert.ok((await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse).every(value => value.ambient.length === 0));
  assert.ok(!(await readFile(join(receipt.directory, 'profile.json'), 'utf8')).includes('PRIVATE_SOURCE_PASSWORD'));
  const before = await readFile(calls); await assert.rejects(exec(process.execPath, [...init, '--candidate-enrollment'], { env }));
  assert.deepEqual(await readFile(calls), before);
});


test('failure after storage initialization retains the policy and partial ledger without automatic recovery', async t => {
  const f = await fixture(t), run = f.input.run;
  f.input.run = async args => { if (f.calls.length) throw Error('PRIVATE_DOCKER_RESULT'); return run(args); };
  await assert.rejects(initializePreviewProfile(f.input), refused);
  assert.deepEqual((await readdir(f.input.output)).sort(), ['ledger', 'profile.initialization.json']);
  assert.deepEqual(f.calls.map(value => value.action), ['initialize']);
  const ledger = join(f.input.output, 'ledger', hash(f.docker.host.ID));
  assert.ok((await readdir(ledger)).includes('launch.pending.json'));
  const original = await readFile(join(ledger, 'launch.pending.json')), policy = structuredClone(f.report.policy);
  await assert.rejects(initializePreviewProfile(f.input), refused);
  assert.deepEqual(await readFile(join(ledger, 'launch.pending.json')), original);
  assert.deepEqual(f.report.policy, policy); assert.equal(f.calls.length, 1);
});

test('status never clears another operation fence or reaches transports while that fence is held', async t => {
  const f = await fixture(t), receipt = await initializePreviewProfile(f.input), profile = await readPreviewProfile(receipt.directory, receipt.profileSha256);
  const held = await acquirePreviewHost(profile.root, profile.engineId), marker = join(profile.root, hash(profile.engineId), 'launch.pending.json');
  try {
    const original = await readFile(marker); f.calls.length = 0; f.docker.calls.length = 0;
    await assert.rejects(f.inspect(receipt), refused);
    assert.deepEqual(await readFile(marker), original); assert.deepEqual(f.calls, []); assert.deepEqual(f.docker.calls, []);
  } finally { await held.fence.release(); }
});
