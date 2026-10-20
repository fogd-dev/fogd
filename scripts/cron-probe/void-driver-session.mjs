import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { upload } from '../queue-probe/context.mjs';
import { expect } from '../guestbook-browser.mjs';

export async function startVoidSession(probe, source, minutes = 12) {
  const runner = join(probe.output, 'runner'); await mkdir(runner);
  for (const file of ['void-controller.mjs', 'void-controller-session.mjs', 'controller-update.mjs', 'minute.mjs']) await cp(new URL(file, import.meta.url), join(runner, file));
  await cp(new URL('../queue-probe/controller-artifact.mjs', import.meta.url), join(runner, 'controller-artifact.mjs'));
  const remote = await upload(probe, runner, 'void-controller');
  let result, failure, terminal = false;
  const running = probe.compose(['exec', '-T', 'controller', 'node', `${remote}/void-controller.mjs`, source, probe.slot.id, remote, String(minutes)], { timeoutMs: (minutes + 5) * 60000 })
    .then(text => { try { result = JSON.parse(text.trim()); } catch (error) { failure = error; } terminal = true; }, error => { failure = error; terminal = true; });
  async function receipt() {
    if (failure) throw failure;
    const value = JSON.parse(await probe.node(`import{readFile}from'node:fs/promises';try{console.log(await readFile(${JSON.stringify(`${remote}/receipt.json`)},'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;console.log('null');}`));
    if (value?.step === 'failed') throw Error(value.error);
    return value;
  }
  async function command(operation, input = {}) {
    const id = randomUUID();
    await probe.node(`import{writeFile,rename}from'node:fs/promises';const path=${JSON.stringify(`${remote}/command.json`)};await writeFile(path+'.tmp',${JSON.stringify(JSON.stringify({ ...input, id, operation }))});await rename(path+'.tmp',path);`);
    await expect.poll(async () => (await receipt())?.command?.id, { timeout: 120000 }).toBe(id);
    return receipt();
  }
  async function finish() {
    await command('finish'); await running; if (failure) throw failure;
    assert.equal(result.step, 'complete'); return result;
  }
  async function releaseUpdate(id) {
    assert.match(id, /^[a-f0-9-]{36}$/);
    await probe.node(`import{writeFile,rename}from'node:fs/promises';const p=${JSON.stringify(`${remote}/update-release.json`)};await writeFile(p+'.tmp',${JSON.stringify(JSON.stringify({ id }))});await rename(p+'.tmp',p);`);
  }
  return { receipt, command, finish, releaseUpdate, get terminal() { return terminal; } };
}
