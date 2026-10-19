import assert from 'node:assert/strict';
import { join } from 'node:path';
import { context } from './queue-probe/context.mjs';
import { chromium, expect } from './guestbook-browser.mjs';

const [slot, output] = process.argv.slice(2);
const probe = await context(slot, output, { queueName: 'imports' });
await probe.queue('pause');
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
// Transport to the real private celld endpoint, not a gateway-routing assertion.
await page.route('http://localhost/**', async route => {
  const request = route.request(), url = new URL(request.url());
  try {
    const response = await probe.http(url.pathname + url.search, { method: request.method(), ...(request.postData() ? { body: request.postData() } : {}) });
    await route.fulfill({ status: response.status, contentType: url.pathname === '/' ? 'text/html' : 'application/json', body: response.body });
  } catch (error) { errors.push(error.message); await route.abort(); }
});
try {
  await page.goto('http://localhost/');
  await page.getByLabel('One label per line').fill('browser apple\nbrowser pear');
  await page.getByLabel('Simulate one retryable failure').check();
  await page.getByRole('button', { name: 'Start import' }).click();
  await expect(page.locator('#status')).toHaveText('No completion recorded yet', { timeout: 30000 });
  const saved = page.url();
  assert.ok(new URL(saved).searchParams.get('id'));
  await page.reload();
  await expect(page.locator('#status')).toHaveText('No completion recorded yet', { timeout: 30000 });
  assert.equal((await probe.queue('info')).paused, true);
  await probe.queue('resume');
  await expect(page.locator('#status')).toHaveText('Import complete', { timeout: 120000 });
  await page.reload();
  await expect(page.locator('#results li')).toHaveText(['BROWSER APPLE', 'BROWSER PEAR'], { timeout: 30000 });
  assert.equal(page.url(), saved);
  const response = await probe.http('/api/imports?id=' + new URL(saved).searchParams.get('id'));
  assert.equal(response.status, 200);
  const job = JSON.parse(response.body);
  assert.equal(job.attempts, 2);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(probe.output, 'completed.png'), fullPage: true });
  await probe.save('browser', { transport: 'Playwright forwards to private celld HTTP via controller; no gateway routing', savedJob: new URL(saved).searchParams.get('id'), results: await page.locator('#results li').allTextContents(), attempts: job.attempts, errors });
  console.log('PASS: browser submission, saved job URL, reload while paused, retryable failure, and completed results after reload');
} finally {
  await page.close();
  await browser.close();
  await probe.queue('pause');
}
