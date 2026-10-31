import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runPreviewForeground } from '../src/preview/launch-command.mjs';
import { createPreviewLaunchRequest } from '../src/preview/launch-request.mjs';
import { previewLaunchFixture, previewLaunchRequestFixture } from './fixtures/preview-launch.mjs';

const exec = promisify(execFile), bin = new URL('../bin/fogd.js', import.meta.url).pathname;
const listeners = () => [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];

test('foreground launch publishes bounded readiness then ordered stop and retains controls, resources and budgets', async t => {
  const f = await previewLaunchFixture(t), before = listeners(), events = [];
  const stopped = await runPreviewForeground(f.args, value => {
    events.push(value);
    if (value.event === 'ready') process.emit('SIGINT');
  });
  assert.deepEqual(events.map(value => value.event), ['ready', 'stopped']);
  assert.equal(events[0].started, true); assert.equal(events[0].control.directory, f.ownerControl.directory);
  assert.equal(JSON.parse(await readFile(join(f.host, 'allocations', f.args.plan.project, 'stop.requested.json'))).reason, 'cancelled'); assert.equal(stopped.ordered, true); assert.equal(stopped.memoryBudgetHeld, true);
  assert.equal(f.observed.containers.length, 10); assert.equal(f.observed.volumes.length, 12);
  assert.ok(f.observed.containers.every(value => !value.State.Running));
  assert.equal((await readdir(join(f.host, 'holds'))).length, 1);
  for (const secret of [f.args.env.FOGD_ADMIN_PASSWORD, f.args.secretValues.storagePassword, f.args.bundle.ingress.accessKey, f.args.bundle.ingress.tls.key]) {
    assert.equal(JSON.stringify(events).includes(secret), false);
  }
  assert.deepEqual(listeners(), before);
});

test('SIGTERM during preflight refuses before effects and removes both signal handlers', async t => {
  const f = await previewLaunchFixture(t), before = listeners(), events = [];
  const pending = runPreviewForeground(f.args, value => events.push(value));
  process.emit('SIGTERM');
  await assert.rejects(pending, { code: 'PREVIEW_EXECUTION_REFUSED' });
  assert.deepEqual(events, []); assert.deepEqual(f.calls, []);
  assert.deepEqual(await readdir(join(f.host, 'holds')), []); assert.deepEqual(listeners(), before);
});

test('lost readiness output requests managed stop before rejecting and leaves owner evidence retained', async t => {
  const f = await previewLaunchFixture(t), before = listeners();
  await assert.rejects(runPreviewForeground(f.args, () => { throw Error('output unavailable'); }), /output unavailable/);
  assert.ok(f.observed.containers.every(value => !value.State.Running));
  assert.equal(JSON.parse(await readFile(join(f.host, 'allocations', f.args.plan.project, 'teardown.complete.json'))).ordered, true);
  assert.equal((await readdir(join(f.host, 'holds'))).length, 1); assert.deepEqual(listeners(), before);
});

test('ambiguous provisioning is retained without a command retry or implicit cleanup', async t => {
  const f = await previewLaunchFixture(t), before = listeners(), run = f.args.run, events = [];
  f.args.run = async (...args) => {
    const value = await run(...args);
    if (args[0][0] === 'network' && args[0][1] === 'create') throw Error('lost response');
    return value;
  };
  await assert.rejects(runPreviewForeground(f.args, value => events.push(value)), { code: 'PREVIEW_HOST_REFUSED', reason: 'uncertain' });
  assert.deepEqual(events, []); assert.equal(f.observed.networks.length, 1);
  assert.equal(JSON.parse(await readFile(join(f.host, 'launch.pending.json'))).phase, 'writing');
  assert.ok(!f.calls.some(args => ['stop', 'rm', 'kill', 'restart'].includes(args[0]))); assert.deepEqual(listeners(), before);
});

test('real launch CLI refuses candidate requests and cannot enable admission through flags or environment', async t => {
  const f = await previewLaunchRequestFixture(t), receipt = await createPreviewLaunchRequest(f.request);
  const tools = join(f.input.root, 'tools'); await mkdir(tools, { mode: 0o700 });
  const calls = join(f.input.root, 'transport-calls');
  for (const name of ['docker', 'ssh']) await writeFile(join(tools, name), `#!${process.execPath}\nimport{appendFile}from'node:fs/promises';await appendFile(${JSON.stringify(calls)},'unexpected');process.exit(3);`, { mode: 0o700 });
  const args = [bin, 'preview', 'launch', '--request', receipt.directory, '--expected-request', receipt.requestSha256, '--storage-host', 'owned-linux'];
  const env = { ...f.args.env, PATH: tools, FOGD_PREVIEW_CANDIDATE_ENROLLMENT: 'true' };
  await assert.rejects(exec(process.execPath, args, { env }), error => {
    assert.match(error.stderr, /Preview launch request refused/); assert.equal(error.stdout, ''); return true;
  });
  await assert.rejects(exec(process.execPath, [...args, '--candidate-enrollment'], { env }));
  await assert.rejects(readFile(calls), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(f.host, 'holds')), []); assert.deepEqual(f.source.calls.filter(value => value.method !== 'GET'), []);
});

test('a stopped graph without continuous storage ordering reports failure and keeps its memory charge', async t => {
  const f = await previewLaunchFixture(t), previous = process.exitCode, events = [];
  t.after(() => { process.exitCode = previous; });
  const stopped = await runPreviewForeground(f.args, value => {
    events.push(value);
    if (value.event === 'ready') {
      const storage = f.observed.containers.find(row => row.Name === '/' + f.args.plan.services.minio.name);
      Object.assign(storage.State, { Running: false, Pid: 0, Status: 'exited' });
      process.emit('SIGTERM');
    }
  });
  assert.equal(stopped.ordered, false); assert.equal(stopped.memoryBudgetHeld, true); assert.equal(process.exitCode, 1);
  assert.equal(events.at(-1).ordered, false); assert.equal((await readdir(join(f.host, 'holds'))).length, 1);
});
