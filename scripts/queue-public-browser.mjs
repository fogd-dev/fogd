import assert from 'node:assert/strict';
import { join } from 'node:path';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { stackRoot } from '../packages/cli/src/local.mjs';
import { request } from './http.mjs';
import { context } from './queue-probe/context.mjs';
import { chromium, expect } from './guestbook-browser.mjs';

const [slot, output] = process.argv.slice(2);
const probe = await context(slot, output, { queueName: 'imports-public-imports' });
const app = 'imports-public';
const cli = args => execute(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), ...args], { env: probe.env });
const delivery = JSON.parse(await cli(['admin', 'delivery', app]));
await cli(['admin', 'delivery', app, 'pause']);
const origin = `http://${app}.localhost:${probe.env.FOGD_HTTP_PORT}`;
const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${app}.localhost 127.0.0.1`] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(origin);
  await page.getByLabel('One label per line').fill('browser apple\nbrowser pear');
  await page.getByLabel('Simulate one retryable failure').check();
  await page.getByRole('button', { name: 'Start import' }).click();
  await expect(page.locator('#status')).toHaveText('No completion recorded yet', { timeout: 30000 });
  const saved = page.url();
  assert.ok(new URL(saved).searchParams.get('id'));
  await page.reload();
  await expect(page.locator('#status')).toHaveText('No completion recorded yet', { timeout: 30000 });
  assert.equal((await probe.queue('info')).paused, true);
  await cli(['admin', 'delivery', app, 'resume', delivery.active.deployment, delivery.active.digest]);
  await expect(page.locator('#status')).toHaveText('Import complete', { timeout: 120000 });
  await page.reload();
  await expect(page.locator('#results li')).toHaveText(['BROWSER APPLE', 'BROWSER PEAR'], { timeout: 30000 });
  assert.equal(page.url(), saved);
  const response = await request(`http://127.0.0.1:${probe.env.FOGD_HTTP_PORT}/api/imports?id=${new URL(saved).searchParams.get('id')}`, { headers: { Host: `${app}.localhost` } });
  assert.equal(response.status, 200);
  const job = await response.json();
  assert.equal(job.attempts, 2);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(probe.output, 'completed.png'), fullPage: true });
  await probe.save('browser', { transport: 'Chromium direct HTTP through workerd virtual host; no request interception', savedJob: new URL(saved).searchParams.get('id'), results: await page.locator('#results li').allTextContents(), attempts: job.attempts, errors });
  console.log('PASS: browser submission, saved job URL, reload while paused, retryable failure, and completed results after reload');
} finally {
  await page.close();
  await browser.close();
  await cli(['admin', 'delivery', app, 'pause']);
}
