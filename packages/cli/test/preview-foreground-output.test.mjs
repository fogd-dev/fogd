import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { previewForegroundOutput } from '../src/preview/foreground-output.mjs';

const moduleURL = name => new URL(name, import.meta.url).href;

test('foreground output observes delayed stream errors until ownership ends', async () => {
  const stream = new Writable({ write(_chunk, _encoding, done) { done(); } }); let cancelled = false;
  const original = stream.listenerCount('error'), output = previewForegroundOutput(() => { cancelled = true; }, stream);
  await output.write({ event: 'ready' }); assert.equal(cancelled, false);
  stream.emit('error', Error('PRIVATE_PIPE_FAILURE'));
  assert.equal(cancelled, true); assert.equal(output.failure.code, 'PREVIEW_OUTPUT_UNAVAILABLE');
  assert.ok(!output.failure.message.includes('PRIVATE_'));
  await assert.rejects(output.write({ event: 'stopped' }), { code: 'PREVIEW_OUTPUT_UNAVAILABLE' });
  output.close(); assert.equal(stream.listenerCount('error'), original);
});

test('a real closed stdout pipe triggers ordered stop before the foreground process exits', { timeout: 30000 }, async t => {
  const program = `
import {runPreviewForeground} from ${JSON.stringify(moduleURL('../src/preview/launch-command.mjs'))};
import {previewLaunchFixture} from ${JSON.stringify(moduleURL('./fixtures/preview-launch.mjs'))};
import {readFile} from 'node:fs/promises';import {join} from 'node:path';
const cleanup=[];let f;
try {
 f=await previewLaunchFixture({after:fn=>cleanup.push(fn)});
 try {await runPreviewForeground(f.args);process.send({unexpectedSuccess:true});}
 catch(error){
  const records=join(f.host,'allocations',f.args.plan.project);
  process.send({code:error.code,stop:JSON.parse(await readFile(join(records,'teardown.complete.json'))),
   request:JSON.parse(await readFile(join(records,'stop.requested.json'))),
   active:f.observed.containers.filter(row=>row.State.Running).length,containers:f.observed.containers.length});
 }
}finally{for(const close of cleanup.reverse())await close();process.disconnect();}
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const report = new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  // Destroy only this owned test child's output reader before readiness.
  child.stdout.destroy();
  const timer = setTimeout(() => child.kill('SIGTERM'), 20000); timer.unref();
  t.after(() => clearTimeout(timer));
  const exit = await closed;
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  const result = await report;
  assert.equal(result.code, 'PREVIEW_OUTPUT_UNAVAILABLE'); assert.equal(result.active, 0); assert.equal(result.containers, 10);
  assert.equal(result.stop.ordered, true); assert.equal(result.stop.memoryBudgetHeld, true); assert.equal(result.request.reason, 'cancelled');
  assert.equal(stderr, '');
});

test('closing the output stream without an error also cancels foreground ownership', async () => {
  const stream = new Writable({ write(_chunk, _encoding, done) { done(); } }); let cancelled = false;
  const output = previewForegroundOutput(() => { cancelled = true; }, stream);
  await output.write({ event: 'ready' });
  const closed = new Promise(resolve => stream.once('close', resolve)); stream.destroy(); await closed;
  assert.equal(cancelled, true);
  await assert.rejects(output.write({ event: 'stopped' }), { code: 'PREVIEW_OUTPUT_UNAVAILABLE' });
  output.close();
});
