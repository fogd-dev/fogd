import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expect } from '../../guestbook-browser.mjs';
import { requireIdleHost } from '../activation/processes.mjs';

export async function startReplacementSession(probe, policy) {
  await requireIdleHost(probe);
  const output = policy.replacement.output, executable = '/app/qualification/replacement-controller.mjs';
  let result, failure, terminal = false, exitCode;
  const running = probe.compose(['exec', '-T', 'controller', '/usr/local/bin/node', executable], { timeoutMs: 25 * 60000 })
    .then(text => { exitCode = 0; try { result = JSON.parse(text.trim()); } catch (error) { failure = error; } terminal = true; }, error => { exitCode = error.exitCode; failure = error; terminal = true; });
  async function readReceipt() {
    const value = JSON.parse(await probe.node(`import{readFile}from'node:fs/promises';try{console.log(await readFile(${JSON.stringify(output+'/receipt.json')},'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;console.log('null')}`));
    return value;
  }
  async function receipt() {
    if (failure) throw failure;
    const value = await readReceipt(); if (value?.step === 'failed') throw Error(value.error); return value;
  }
  async function send(operation, input = {}) {
    const id = randomUUID();
    await probe.node(`import{saveJson}from'/app/packages/platform/src/store.mjs';await saveJson(${JSON.stringify(output+'/command.json')},${JSON.stringify({ ...input, id, operation })});`);
    return id;
  }
  async function command(operation, input = {}) {
    const id = await send(operation, input);
    await expect.poll(async () => (await receipt())?.command?.id, { timeout: 120000 }).toBe(id);
    return receipt();
  }
  async function finish() {
    await command('finish'); await running; if (failure) throw failure;
    assert.equal(exitCode, 0); assert.equal(result.step, 'complete'); await requireIdleHost(probe); return result;
  }
  async function kill() {
    const value = await readReceipt(); assert.ok(value?.pid > 1 && /^\d+$/.test(value.processStart));
    const expected = JSON.stringify(['/usr/local/bin/node', executable]);
    await probe.node(`import{readFile}from'node:fs/promises';const pid=${value.pid};const args=(await readFile('/proc/'+pid+'/cmdline','utf8')).split('\\0').slice(0,-1);const start=(await readFile('/proc/'+pid+'/stat','utf8')).split(' ')[21];if(JSON.stringify(args)!==${JSON.stringify(expected)}||start!==${JSON.stringify(value.processStart)})throw Error('Private controller PID changed');process.kill(pid,'SIGKILL');`);
    await running; assert.equal(exitCode, 137); await requireIdleHost(probe);
  }
  async function releaseUpdate(id) {
    assert.match(id, /^[a-f0-9-]{36}$/);
    await probe.node(`import{saveJson}from'/app/packages/platform/src/store.mjs';await saveJson(${JSON.stringify(output+'/update-release.json')},${JSON.stringify({ id })});`);
  }
  return { receipt, rawReceipt: readReceipt, send, command, finish, kill, releaseUpdate, wait: () => running,
    get terminal() { return terminal; }, get exitCode() { return exitCode; } };
}
