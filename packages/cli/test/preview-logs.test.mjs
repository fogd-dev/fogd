import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import { previewOwnerFixture } from './fixtures/preview-owner.mjs';
import { capturePreviewLogs } from '../src/preview/logs.mjs';
import { jsonBytes, hash } from '../src/build-cache/paths.mjs';

async function fixture(t, options = {}) {
  const f = await previewOwnerFixture(t), output = join(f.input.root, 'private-logs');
  const result = { status: 'captured', stdoutBytes: 20, stderrBytes: 20, exitCode: 0, signal: null, reason: null };
  const captured = [], capture = async (command, args, options) => {
    captured.push({ command, args, options });
    await writeFile(options.stdout, 'PRIVATE_STDOUT_DATA\n', { mode: 0o600 });
    await writeFile(options.stderr, 'PRIVATE_STDERR_DATA\n', { mode: 0o600 });
    return result;
  };
  const input = { directory: f.ownerDirectory, allocationId: f.args.allocationId, role: 'slot-1-a', output, run: f.args.run, capture, ...options };
  return { ...f, request: input, output, captured, captureResult: result, logs: extra => capturePreviewLogs({ ...input, ...extra }) };
}
const refused = { code: 'PREVIEW_LOGS_REFUSED' };

test('preview logs bind an exact role and save both private streams without disclosing their contents', async t => {
  const f = await fixture(t), result = await f.logs();
  assert.equal(result.status, 'captured'); assert.equal(result.scope, 'matched-at-boundaries'); assert.equal(result.health, 'not-assessed');
  assert.equal(result.container, f.f.created.containers['slot-1-a']); assert.equal(result.disclosure, 'unredacted-owner-only');
  assert.equal(result.capture.files.stdout.sha256, hash('PRIVATE_STDOUT_DATA\n'));
  assert.deepEqual(f.captured[0].args, ['--context', 'owner-browser-fixture', 'logs', '--timestamps', '--tail', '2000', result.container]);
  assert.equal(f.captured[0].options.maxBytes, 1048576); assert.equal(f.captured[0].options.timeoutMs, 15000);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_STD')); assert.equal((await stat(f.output)).mode & 0o7777, 0o700);
  for (const name of ['stdout.log', 'stderr.log', 'capture.json']) assert.equal((await stat(join(f.output, name))).mode & 0o7777, 0o600);
  assert.deepEqual(f.source.calls, []); assert.ok(!f.calls.some(args => ['start', 'stop', 'exec', 'rm', 'kill'].includes(args[0])));
});

test('a torn pending operation remains intact while exact-role logs can be inspected', async t => {
  const f = await fixture(t), marker = join(f.host, 'launch.pending.json'), bytes = '{PRIVATE_PENDING_OPERATION';
  await writeFile(marker, bytes, { mode: 0o600 }); const before = await stat(marker), holds = await readdir(join(f.host, 'holds'));
  const result = await f.logs(); assert.equal(result.status, 'captured'); assert.equal(result.before.pendingOperation, true); assert.equal(result.after.pendingOperation, true);
  assert.equal(await readFile(marker, 'utf8'), bytes); assert.equal((await stat(marker)).ino, before.ino); assert.deepEqual(await readdir(join(f.host, 'holds')), holds);
});

for (const [name, change] of Object.entries({
  role: f => ({ role: '__proto__' }), tail: f => ({ tail: 10001 }),
  existingOutput: async f => { await mkdir(f.output); return {}; },
  hostOutput: f => ({ output: join(f.host, 'logs') }), ownerOutput: f => ({ output: join(f.ownerDirectory, 'logs') }),
  wrongEngine: f => { f.f.observed.host.ID = 'wrong-engine'; return {}; },
  wrongContainer: f => { f.f.observed.containers.find(c => c.Id === f.f.created.containers['slot-1-a']).Id = 'e'.repeat(64); return {}; },
})) test(`preview log ${name} refuses before collection`, async t => {
  const f = await fixture(t); await assert.rejects(f.logs(await change(f)), refused); assert.deepEqual(f.captured, []);
  if (name !== 'existingOutput') await assert.rejects(access(f.output), { code: 'ENOENT' });
});

test('partial capture remains private and is never repeated', async t => {
  const f = await fixture(t); Object.assign(f.captureResult, { status: 'partial', reason: 'output-limit' });
  const result = await f.logs(); assert.equal(result.status, 'partial'); assert.equal(result.capture.reason, 'output-limit'); assert.equal(f.captured.length, 1);
  assert.equal(await readFile(join(f.output, 'stderr.log'), 'utf8'), 'PRIVATE_STDERR_DATA\n');
});

test('changed post-capture scope retains files and reports uncertainty without another collection', async t => {
  const f = await fixture(t), capture = f.request.capture;
  f.request.capture = async (...args) => { const result = await capture(...args); const path = join(f.ownerDirectory, 'owner.json'), control = JSON.parse(await readFile(path)); control.dockerContext = 'another-context'; await writeFile(path, jsonBytes(control)); return result; };
  const result = await f.logs(); assert.equal(result.status, 'scope-unconfirmed'); assert.equal(result.after, null); assert.equal(f.captured.length, 1);
  assert.equal((await readdir(f.output)).length, 3);
});

for (const [marker, parent] of [['profile.json', f => f.input.root], ['request.complete.json', f => f.input.root]]) {
  test(`log output cannot be added inside ${marker} records`, async t => {
    const f = await fixture(t); await writeFile(join(parent(f), marker), '{}', { mode: 0o600 });
    await assert.rejects(f.logs(), refused); assert.deepEqual(f.captured, []); await assert.rejects(access(f.output), { code: 'ENOENT' });
  });
}

test('real preview logs CLI captures stderr privately with an explicit context and no inherited source environment', async t => {
  const f = await fixture(t), tools = join(f.input.root, 'logs-tools'), calls = join(f.input.root, 'log-cli-calls.jsonl'); await mkdir(tools);
  const state = join(f.input.root, 'log-cli-state.json'); await writeFile(state, JSON.stringify({ observed: f.f.observed, image: f.f.image }), { mode: 0o600 });
  await writeFile(join(tools, 'docker'), `#!${process.execPath}
import{readFile,appendFile}from'node:fs/promises';const input=process.argv.slice(2),args=input.slice(2);if(input[0]!=='--context'||input[1]!=='owner-browser-fixture')process.exit(2);await appendFile(${JSON.stringify(calls)},JSON.stringify({args,ambient:Object.keys(process.env).filter(k=>k.startsWith('DOCKER_')||k.startsWith('FOGD_'))})+'\\n');const{observed:v,image}=JSON.parse(await readFile(${JSON.stringify(state)}));if(args[0]==='logs'){if(args.at(-1)!==${JSON.stringify(f.f.created.containers['slot-1-a'])})process.exit(3);console.log('PRIVATE_STDOUT_LOG');console.error('PRIVATE_STDERR_LOG');}else if(args[0]==='info')console.log(JSON.stringify(v.host));else if(args[0]==='image')console.log(JSON.stringify([image]));else{const items=v[{container:'containers',network:'networks',volume:'volumes'}[args[0]]];if(!items)process.exit(4);if(args[1]==='ls')console.log(items.map(i=>args[0]==='volume'?i.Name:i.Id).join('\\n'));else if(args[1]==='inspect')console.log(JSON.stringify(items));else process.exit(5)}`, { mode: 0o700 });
  const { promisify } = await import('node:util'), { execFile } = await import('node:child_process');
  const result = await promisify(execFile)(process.execPath, [new URL('../bin/fogd.js', import.meta.url).pathname, 'preview', 'logs', f.args.allocationId,
    '--control', f.ownerDirectory, '--role', 'slot-1-a', '--output', f.output, '--tail', '100'],
  { env: { ...process.env, ...f.source.env, PATH: tools, DOCKER_CONTEXT: 'wrong-context', DOCKER_HOST: 'tcp://wrong-target' }, timeout: 30000 });
  const report = JSON.parse(result.stdout); assert.equal(report.status, 'captured'); assert.equal(report.tail, 100); assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes('PRIVATE_STD')); assert.equal(await readFile(join(f.output, 'stderr.log'), 'utf8'), 'PRIVATE_STDERR_LOG\n');
  const rows = (await readFile(calls, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row => row.args[0] === 'logs').length, 1); assert.ok(rows.every(row => row.ambient.length === 0));
  assert.ok(rows.every(row => !['start', 'stop', 'exec', 'rm', 'kill'].includes(row.args[0])));
});

test('a process stopping during capture does not replace its immutable log scope or imply health', async t => {
  const f = await fixture(t), capture = f.request.capture;
  f.request.capture = async (...args) => {
    const result = await capture(...args), container = f.f.observed.containers.find(row => row.Id === f.f.created.containers['slot-1-a']);
    Object.assign(container.State, { Status: 'exited', Running: false, Pid: 0, ExitCode: 0 }); return result;
  };
  const result = await f.logs(); assert.equal(result.status, 'captured'); assert.equal(result.scope, 'matched-at-boundaries');
  assert.equal(result.before.state, 'running'); assert.equal(result.after.state, 'exited'); assert.equal(result.health, 'not-assessed');
});
