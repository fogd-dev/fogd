import assert from 'node:assert/strict';
import { join } from 'node:path';
import { chromium, expect } from '../../guestbook-browser.mjs';
import { beginFailurePhase, firstFailureOccurrence, assertHealthyOccurrence, pauseFailureWork } from './failure-phases.mjs';
import { rows } from './recovery-ledger.mjs';
import { setRefreshSource as setFailureSource } from './refresh-client.mjs';

export { setFailureSource };
export async function selectedFailureBrowser({ host, fixture, active, clock, evidence }) {
  evidence.initialPause = await pauseFailureWork(host, active, clock);
  await setFailureSource(host, fixture, 'offline');
  evidence.phase = await beginFailurePhase(host, active, 'ui-offline', clock);
  evidence.first = await firstFailureOccurrence(host, active, evidence.phase);
  assert.ok(evidence.first.attempts.some(row => row.job === 'advisory' && row.outcome === 'thrown' && row.no_retry_called === 0));
  const advisory = rows(evidence.first.observed, 'refresh_occurrences').find(row => row.job === 'advisory' && row.scheduled_time === evidence.first.time);
  assert.equal(advisory.status, 'failed'); assert.match(advisory.error, /local advisory source is unavailable/);
  const saved = rows(evidence.first.observed, 'refresh_results').filter(row => row.job === 'advisory').sort((a, b) => a.scheduled_time - b.scheduled_time); assert.ok(saved.length > 0);
  evidence.lastSuccessfulAdvisory = saved.at(-1); assert.ok(evidence.lastSuccessfulAdvisory.scheduled_time < evidence.first.time);
  assert.ok(!saved.some(row => row.scheduled_time === evidence.first.time));
  evidence.failedPause = await pauseFailureWork(host, active, clock);
  evidence.failed = await browserState(host, 'failed', evidence.lastSuccessfulAdvisory);
  await setFailureSource(host, fixture, 'healthy');
  // Native pause clears owed retry identity; resume must arm a future occurrence.
  evidence.healthy = await beginFailurePhase(host, active, 'ui-healthy', clock);
  evidence.healthy.first = await firstFailureOccurrence(host, active, evidence.healthy); assertHealthyOccurrence(evidence.healthy.first);
  evidence.recoveredPause = await pauseFailureWork(host, active, clock);
  const recovered = rows(evidence.recoveredPause.observed, 'refresh_results').filter(row => row.job === 'advisory').sort((a, b) => a.scheduled_time - b.scheduled_time).at(-1);
  evidence.recovered = await browserState(host, 'healthy', recovered);
  evidence.heldIntervals = [{ start: evidence.initialPause.heldAt, end: evidence.phase.held.end }, { start: evidence.failedPause.heldAt, end: evidence.healthy.held.end }];
}
export async function browserState(host, name, saved, replacement) {
  assert.ok(['baseline', 'failed', 'healthy', 'replacement'].includes(name)); assert.ok(saved && Number.isSafeInteger(saved.saved_at));
  assert.equal(name === 'replacement', replacement !== undefined);
  host.access?.({ kind: 'browser', app: 'refresh', name });
  const browser = await chromium.launch(), errors = [], responses = [], origin = `https://refresh.localhost:${host.gatewayPort}`;
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { responses.push({ url: new URL(response.url()).pathname, status: response.status() }); });
    await page.goto(origin);
    await expect(page.getByRole('heading', { name: 'Saved refreshes', exact: true })).toBeVisible();
    await expect(page.locator('#read-status')).toHaveText('Saved results checked. Updates continue with this page closed.');
    await expect(page.getByRole('region', { name: 'inventory', exact: true }).locator('dd').first()).toHaveText('Saved');
    const advisory = page.getByRole('region', { name: 'advisory', exact: true });
    await expect(advisory.locator('dd').first()).toHaveText(name === 'failed' ? 'Refresh failed' : 'Saved');
    if (name === 'failed') { await expect(advisory).toContainText('The local advisory source is unavailable.');  }
    await expect(advisory.locator('dd').nth(2)).toHaveText(saved.value);
    const date = await page.evaluate(value => new Date(value).toLocaleString(), saved.saved_at); await expect(advisory.locator('dd').nth(1)).toHaveText(date);
    if (replacement) {
      const { unfinished, inventory } = replacement;
      assert.equal(unfinished.job, 'advisory'); assert.ok(Number.isSafeInteger(unfinished.scheduled_time)); assert.ok(inventory && Number.isSafeInteger(inventory.saved_at));
      const inventoryView = page.getByRole('region', { name: 'inventory', exact: true });
      await expect(inventoryView.locator('dd').nth(2)).toHaveText(inventory.value);
      await expect(inventoryView.locator('dd').nth(1)).toHaveText(await page.evaluate(value => new Date(value).toLocaleString(), inventory.saved_at));
      const time = await page.evaluate(value => new Date(value).toLocaleString(), unfinished.scheduled_time);
      await expect(page.locator('#unfinished li')).toHaveCount(1);
      await expect(page.getByRole('region', { name: 'Unfinished refreshes', exact: true })).toContainText(`advisory at ${time}: No completion recorded`);
      await expect(page.locator('#unfinished-more')).toHaveText('');
    }
    const screenshot = `${name}.png`; await page.screenshot({ path: join(host.output, screenshot), fullPage: true });
    const text = await page.locator('main').innerText(); assert.deepEqual(errors, []); assert.ok(responses.some(row => row.url === '/api/refresh' && row.status === 200));
    assert.ok(responses.every(row => row.status < 400)); return { screenshot, text, errors, responses };
  } finally { await browser.close(); }
}
