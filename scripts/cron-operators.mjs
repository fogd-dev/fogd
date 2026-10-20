import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { context, upload } from './queue-probe/context.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { chromium, expect } from './guestbook-browser.mjs';
import { refreshGateway } from './cron-probe/gateway.mjs';
import { cleanupCronProbe } from './cron-probe-cleanup.mjs';
import { vmMinuteBoundary } from './cron-probe/vm-time.mjs';

// Run after cron-void against its stopped, retained private controller and fleet.
const [slot, output, priorEvidence, origin] = process.argv.slice(2);
assert.match(origin || '', /^http:\/\/127\.0\.0\.1:\d+$/);
const prior = JSON.parse(await readFile(priorEvidence, 'utf8'));
assert.equal(prior.controller.step, 'complete');
const probe = await context(slot, output);
const dir = dirname(dirname(prior.controller.artifact));
const runner = join(probe.output, 'runner'); await mkdir(runner);
await cp(new URL('./cron-probe/operator-controller.mjs', import.meta.url), join(runner, 'controller.mjs'));
const remote = await upload(probe, runner, 'operator-controller');
const auth = { Authorization: `Basic ${Buffer.from(`${probe.env.FOGD_ADMIN_USER}:${probe.env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` };
const path = '/v1/apps/refresh/dispatch';
let result, runnerError, failure, browser, csrf;
const startRunner = () => probe.compose(['exec', '-T', 'controller', 'node', `${remote}/controller.mjs`, dir, slot, remote])
  .then(value => { result = JSON.parse(value.trim()); }, error => { runnerError = error; });
let running = startRunner();
async function receipt() {
  if (runnerError) throw runnerError;
  return JSON.parse(await probe.node(`import{readFile}from'node:fs/promises';try{console.log(await readFile(${JSON.stringify(`${remote}/receipt.json`)},'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;console.log('null');}`));
}
async function command(operation, publicSurfaces = []) {
  const id = randomUUID();
  await probe.node(`import{writeFile,rename}from'node:fs/promises';const p=${JSON.stringify(`${remote}/command.json`)};await writeFile(p+'.tmp',${JSON.stringify(JSON.stringify({ id, operation, publicSurfaces }))});await rename(p+'.tmp',p);`);
  await expect.poll(async () => (await receipt())?.command?.id, { timeout: 30000 }).toBe(id);
  return receipt();
}
async function status() { const response = await fetch(origin + path, { headers: auth }); assert.equal(response.status, 200); return response.json(); }
const post = (action, input = {}) => fetch(origin + path + '/' + action, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Fogd-CSRF': csrf }, body: JSON.stringify(input) });
const cli = args => execute(process.execPath, ['packages/cli/bin/fogd.js', 'admin', 'dispatch', 'refresh', ...args], {
  env: { ...probe.env, FOGD_SERVER: origin }, timeoutMs: 30000,
});
async function appState() { const response = await refreshGateway(probe.env.FOGD_HTTP_PORT, '/api/refresh'); assert.equal(response.status, 200); return response.json(); }
try {
  await expect.poll(async () => (await receipt())?.step, { timeout: 120000 }).toBe('ready');
  const before = await command('inspect'); assert.equal(before.native.paused, true);
  const state = await status(), admin = await (await fetch(origin + '/v1/admin', { headers: auth })).json(); csrf = admin.csrf;
  const pageText = await (await fetch(origin, { headers: auth })).text();
  const cliText = await cli(['status']); assert.deepEqual(JSON.parse(cliText), state); assert.equal(state.desired, 'paused');
  assert.equal((await post('resume', { ...state.active, digest: '0'.repeat(64) })).status, 400);
  const readCheck = await command('inspect', [JSON.stringify(state), JSON.stringify(admin), pageText, cliText]);
  assert.deepEqual(readCheck.commands.slice(before.commands.length), ['info']);
  assert.equal(readCheck.privateValuesAbsent, true); assert.equal(readCheck.adoptedApprovedVersion, true);
  assert.equal((await post('observe')).status, 200);
  await command('lose-resume-reply');
  const lost = await post('resume', state.active); assert.equal(lost.status, 502);
  const errorText = await lost.text(); assert.ok(!errorText.includes('Injected'));
  const unknown = await status(); assert.equal(unknown.observed, 'unknown'); assert.equal(unknown.operation, 'resume');
  const actual = await command('inspect'); assert.equal(actual.native.paused, false);
  const observed = await (await post('observe')).json(); assert.equal(observed.observed, 'running'); assert.equal(observed.operation, 'resume');
  const paused = JSON.parse(await cli(['pause'])); assert.equal(paused.desired, 'paused'); assert.equal(paused.operation, null); assert.equal(paused.observed, 'paused');
  browser = await chromium.launch();
  const page = await browser.newPage({ httpCredentials: { username: probe.env.FOGD_ADMIN_USER, password: probe.env.FOGD_ADMIN_PASSWORD } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: 'refresh scheduled dispatch', exact: true })).toBeVisible();
  await page.locator('[data-dispatch="resume"]').click();
  await expect.poll(async () => (await status()).observed, { timeout: 30000 }).toBe('running');
  const initial = await appState();
  let tick;
  await expect.poll(async () => { tick = await appState(); return tick.history.some(row => !initial.history.some(old => old.job === row.job && old.scheduled_time === row.scheduled_time) && row.status === 'complete'); }, { timeout: 120000 }).toBe(true);
  await page.reload(); await page.locator('[data-dispatch="pause"]').click();
  await expect.poll(async () => (await status()).observed, { timeout: 30000 }).toBe('paused');
  await page.reload(); await expect(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Scheduled dispatch', exact: true }) })).toContainText('Approval: active at complete');
  await page.screenshot({ path: join(probe.output, 'dispatch.png'), fullPage: true });
  assert.deepEqual(errors, []); await browser.close(); browser = null;
  // No armed alarm is a hold observation, not evidence of a drain.
  await expect.poll(async () => (await command('inspect')).native.nextAlarm, { timeout: 30000 }).toBe(null);
  const frozen = await appState(), boundary = await vmMinuteBoundary(probe);
  assert.deepEqual(await appState(), frozen);
  await probe.compose(['restart', ...probe.slot.nodes]);
  await expect.poll(async () => {
    try { const restored = await command('inspect'); return restored.adoptedApprovedVersion && restored.native.paused && restored.native.nextAlarm === null; }
    catch { return false; }
  }, { timeout: 90000 }).toBe(true);
  assert.deepEqual(await appState(), frozen);
  const finalPage = await (await fetch(origin, { headers: auth })).text();
  const finished = await command('finish', [errorText, JSON.stringify(unknown), JSON.stringify(observed), JSON.stringify(paused), finalPage]);
  await running; if (runnerError) throw runnerError;
  assert.equal(result.step, 'complete'); assert.equal(finished.privateValuesAbsent, true);
  const firstController = result;
  await probe.node(`import{rm}from'node:fs/promises';for(const name of ['command.json','receipt.json'])await rm(${JSON.stringify(remote)}+'/'+name);`);
  result = null; running = startRunner();
  await expect.poll(async () => (await receipt())?.step, { timeout: 90000 }).toBe('ready');
  assert.deepEqual((await receipt()).commands, []);
  assert.equal((await status()).desired, 'paused');
  const reopened = await command('inspect'); assert.equal(reopened.native.paused, true);
  await command('finish'); await running; if (runnerError) throw runnerError; assert.equal(result.step, 'complete');
  await probe.save('operators', { active: state.active, recordedReadsNoRuntimeEffects: true, privateValuesAbsent: true, digestMismatchRejected: true,
    unknown, observed, paused, nativeRunningAfterLostReply: !actual.native.paused, futureTick: tick, heldAcrossBoundary: boundary,
    browser: { errors, resumed: true, paused: true, approvalVisible: true }, controller: firstController,
    replicaRestartHeld: true, controllerReloadHeldWithoutDispatchCommands: true, reopenedController: result,
    scope: 'Private qualified runtime injection; authenticated admin API, CLI and browser. No cron admission, stopped fresh-storage recovery, drain or atomic release fence.' });
  console.log('PASS: native scheduled operator status, lost reply, explicit reconciliation, browser controls and persisted pause');
} catch (error) { failure = error; await probe.save('failure', { message: error.message }); throw error; }
finally {
  await browser?.close();
  if (!result && !runnerError) { try { await command('finish'); await running; } catch { /* Independent native pause follows. */ } }
  try { await cleanupCronProbe(probe, () => probe.cli(['cron', 'pause', 'refresh', '--json'])); }
  catch (error) { if (!failure) throw error; console.error('Cleanup failed; stop the disposable fleet and retain private evidence'); }
}
