import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stackRoot } from '../packages/cli/src/local.mjs';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(stackRoot, '.fogd/browsers');
const { chromium, expect } = await import('@playwright/test');
export { chromium, expect };

async function readSummary(page) {
  await expect(async () => {
    await page.getByRole('button', { name: 'Check saved messages' }).click();
    await expect(page.getByRole('status')).toHaveText(/\d+ saved messages/);
  }).toPass({ timeout: 30000 });
}

export async function verifyBrowser(url, text, heading = 'Guestbook') {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (/\.(js|css)(\?|$)/.test(response.url()) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  try {
    await page.goto(url);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    // SSR is visible before hydration. A successful read-only client action
    // establishes that React has attached handlers before filling the form.
    await readSummary(page);
    await page.getByLabel('Your message').fill(text);
    await page.getByRole('button', { name: 'Add message' }).click();
    await expect(page.getByRole('list', { name: 'Messages' })).toContainText(text);
    await page.reload();
    await expect(page.getByRole('list', { name: 'Messages' })).toContainText(text);
    await readSummary(page);
    await page.screenshot({ path: join(stackRoot, '.fogd/guestbook.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
