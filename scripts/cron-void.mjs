import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { context, requireEmptyFleet, upload } from './queue-probe/context.mjs';
import { stageRefresh } from './cron-probe/native.mjs';
import { cleanupCronProbe } from './cron-probe-cleanup.mjs';
import { chromium, expect } from './guestbook-browser.mjs';

const probe = await context(process.argv[2], process.argv[3]); await requireEmptyFleet(probe);
const port = probe.env.FOGD_HTTP_PORT, url = `http://refresh.localhost:${port}`;
const stage = await stageRefresh(join(probe.output, 'app'));
const source = await upload(probe, stage.output, 'void-refresh');
const runner = join(probe.output, 'runner'); await mkdir(runner);
await cp(new URL('./cron-probe/void-controller.mjs', import.meta.url), join(runner, 'controller.mjs'));
await cp(new URL('./queue-probe/controller-artifact.mjs', import.meta.url), join(runner, 'controller-artifact.mjs'));
const remote = await upload(probe, runner, 'void-controller');
let runnerError, result, failure, browser;
const running = probe.compose(['exec', '-T', 'controller', 'node', `${remote}/controller.mjs`, source, probe.slot.id, remote])
  .then(value => { result = JSON.parse(value.trim()); }, error => { runnerError = error; });
async function receipt() {
  if (runnerError) throw runnerError;
  const value = JSON.parse(await probe.node(`import{readFile}from'node:fs/promises';try{console.log(await readFile(${JSON.stringify(`${remote}/receipt.json`)},'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;console.log('null');}`));
  if (!value) return null;
  if (value.step === 'failed') throw Error(value.error);
  return value;
}
async function command(operation) {
  const id = randomUUID();
  await probe.node(`import{writeFile,rename}from'node:fs/promises';const path=${JSON.stringify(`${remote}/command.json`)};await writeFile(path+'.tmp',${JSON.stringify(JSON.stringify({id,operation}))});await rename(path+'.tmp',path);`);
  await expect.poll(async () => (await receipt())?.command?.id, { timeout: 30000 }).toBe(id);
}
async function api(mode) {
  const response = await gateway('/api/refresh', mode ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify({ mode }) } : {});
  assert.equal(response.status, 200); return response.json();
}
function gateway(path, options = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method: options.method || 'GET', headers: { Host: `refresh.localhost:${port}`, ...options.headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode })));
      response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(15000, () => request.destroy(Error('Gateway request timed out')));
    request.end(options.body);
  });
}
const latest = (state, job) => state.jobs.find(row => row.job === job).latest;
async function bothComplete(mode, duplicates) {
  let state, occurrence;
  await expect.poll(async () => {
    state = await api();
    occurrence = state.history.find(row => row.job === 'advisory' && row.status === 'complete' && row.initial_mode === mode && row.duplicates >= duplicates &&
      state.history.some(sibling => sibling.job === 'inventory' && sibling.scheduled_time === row.scheduled_time && sibling.status === 'complete' && sibling.duplicates >= 1));
    return Boolean(occurrence);
  }, { timeout: 120000, intervals: [200, 500] }).toBe(true);
  return { state, occurrence };
}
try {
  await expect.poll(async () => (await receipt())?.step || 'starting', { timeout: 180000 }).toBe('active');
  const active = await receipt();
  const first = await bothComplete('retry-once', 0), retried = first.state;
  assert.ok(first.occurrence.attempts >= 2);
  const manual = await gateway('/__void/scheduled', { method: 'POST', body: '{}' }); assert.equal(manual.status, 404);
  const directManual = await probe.http('/__void/scheduled', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cron: '* * * * *', scheduledTime: 0 }) });
  assert.equal(directManual.status, 401);
  await api('offline');
  let failed;
  await expect.poll(async () => {
    failed = await api(); return latest(failed, 'advisory')?.status === 'failed' && latest(failed, 'advisory').initial_mode === 'offline' && latest(failed, 'advisory').scheduled_time > first.occurrence.scheduled_time;
  }, { timeout: 90000, intervals: [200, 500] }).toBe(true);
  await command('pause');
  browser = await chromium.launch(); const page = await browser.newPage(); const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Saved refreshes', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'advisory' })).toContainText('Refresh failed');
  await expect(page.getByRole('region', { name: 'advisory' })).not.toContainText('No saved result yet');
  await expect(page.getByRole('region', { name: 'inventory' })).toContainText('Saved');
  await page.screenshot({ path: join(probe.output, 'failure.png'), fullPage: true });
  await page.getByLabel('Advisory source', { exact: true }).selectOption('lost-ack-once');
  await page.getByRole('button', { name: 'Save source mode' }).click();
  await expect(page.locator('#settings-status')).toContainText('Source mode saved');
  assert.deepEqual(browserErrors, []); await browser.close(); browser = null;
  await command('resume'); const lost = await bothComplete('lost-ack-once', 1), lostAck = lost.state;
  assert.ok(lost.occurrence.last_attempt_at > lost.occurrence.completed_at, 'A real retry must follow the committed save');
  await command('pause');
  let final;
  await expect.poll(async () => {
    final = await api();
    const direct = await Promise.all(probe.slot.nodes.map(node => probe.node(`const r=await fetch(${JSON.stringify(`http://${node}:8080/api/refresh`)});if(!r.ok)throw Error('Replica read');console.log(await r.text());`)));
    return direct.every(value => isDeepStrictEqual(JSON.parse(value), final));
  }, { timeout: 30000 }).toBe(true);
  const sql = 'SELECT job,cron,scheduled_time,value,saved_at FROM refresh_results ORDER BY scheduled_time,job;';
  const rows = (await probe.cli(['d1','execute','refresh-db','--command',sql,active.artifact,'--json'])).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(rows.length >= 5);
  for (const occurrence of [first.occurrence, lost.occurrence]) {
    const saved = rows.filter(row => row.scheduled_time === occurrence.scheduled_time);
    assert.deepEqual(saved.map(row => row.job).sort(), ['advisory', 'inventory']);
    assert.equal(saved.find(row => row.job === 'advisory').saved_at, occurrence.completed_at);
  }
  const replicas = await probe.state();
  await command('finish'); await running; if (runnerError) throw runnerError;
  assert.equal(result.step, 'complete');
  await probe.save('void', { active, retried, retriedOccurrence: first.occurrence, failed, lostAck, lostAckOccurrence: lost.occurrence, final, rows, replicas, controller: result,
    browser: { errors: browserErrors, failureVisible: true, retainedSuccessVisible: true, settingChanged: true },
    nativeDeclarations: stage.source.triggers, scope: 'Ordinary Void code generation and native jobs through private controller staging and normal workerd routing. No ordinary cron admission, full M11c recovery or exactly-once external effects.' });
  console.log('PASS: native Void shared schedule, failure UI and job-level lost-ack deduplication through workerd');
} catch (error) { failure = error; await probe.save('failure', { message: error.message }); throw error; }
finally {
  await browser?.close();
  if (!result && !runnerError) {
    try { await command('finish'); await running; } catch { /* Native pause below is independent of the runner. */ }
  }
  try { await cleanupCronProbe(probe, () => probe.cli(['cron','pause','refresh','--json'])); }
  catch (error) { if (!failure) throw error; console.error('Cleanup failed; stop the disposable fleet and retain its private evidence'); }
}
