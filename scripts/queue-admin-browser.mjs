import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, expect } from './guestbook-browser.mjs';
import { context } from './queue-probe/context.mjs';

const [slot, output] = process.argv.slice(2);
const probe = await context(slot, output, { queueName: 'imports' });
const origin = `http://127.0.0.1:${probe.env.FOGD_ADMIN_PORT}`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ httpCredentials: { username: probe.env.FOGD_ADMIN_USER, password: probe.env.FOGD_ADMIN_PASSWORD } });
  await page.goto(origin);
  await expect(page.getByText('Desired: paused.', { exact: false })).toBeVisible();
  for (const action of ['resume', 'observe', 'pause']) {
    const response = page.waitForResponse(response => response.url() === origin + '/v1/apps/imports/delivery/' + action);
    await page.locator(`button[data-delivery="${action}"]`).click();
    assert.equal((await response).status(), 200);
    await page.waitForLoadState('load');
    await expect(page.getByText(`Desired: ${action === 'pause' ? 'paused' : 'running'}.`, { exact: false })).toBeVisible();
  }
  assert.equal((await probe.queue('info')).paused, true);
  await page.screenshot({ path: join(probe.output, 'admin.png'), fullPage: true });
  await probe.save('browser', { actions: ['resume', 'observe', 'pause'], realRuntimePaused: true });
  console.log('PASS: admin browser controls resume, refresh, and pause the real queue');
} finally { await browser.close(); }
