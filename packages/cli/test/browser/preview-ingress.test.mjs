import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import { ingressFixture, key } from '../fixtures/preview-ingress.mjs';

test('a real browser signs in without exposing the gateway cookie to the app', { timeout: 30000 }, async t => {
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const f = await ingressFixture(t, { publicPort: port, respond: (request, response) => {
    if (request.url === '/api/check') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ cookie: request.headers.cookie, authorization: request.headers.authorization })); return;
    }
    response.setHeader('content-type', 'text/html');
    response.setHeader('set-cookie', 'app-session=kept; Secure; HttpOnly; Path=/');
    response.end('<!doctype html><html lang="en"><title>App preview</title><h1>Application preview</h1></html>');
  } });
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.FOGD_TEST_CHROMIUM || chromium.executablePath(),
    args: ['--no-proxy-server', '--host-resolver-rules=MAP preview.test 127.0.0.1'],
  });
  t.after(() => browser.close());
  // Only this isolated fixture context accepts its self-signed frontend leaf.
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  assert.equal((await page.goto(f.config.origin)).status(), 401); assert.equal(f.calls.length, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByLabel('Preview access key').fill(key);
  const submitted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/.well-known/fogd-preview/login');
  await page.getByRole('button', { name: 'Open preview' }).click();
  assert.equal((await submitted).status(), 303);
  await page.getByRole('heading', { name: 'Application preview' }).waitFor();
  const cookie = (await context.cookies(f.config.origin)).find(value => value.name === '__Host-fogd-preview');
  assert.ok(cookie.httpOnly && cookie.secure && cookie.sameSite === 'Strict');
  assert.ok(!(await page.evaluate(() => document.cookie)).includes('__Host-fogd-preview'));
  const echoed = await page.evaluate(async () => (await fetch('/api/check', { headers: { Authorization: 'Bearer app-only' } })).json());
  assert.deepEqual(echoed, { cookie: 'app-session=kept', authorization: 'Bearer app-only' });
  assert.ok(!JSON.stringify(f.calls).includes(cookie.value));
  const refused = await page.evaluate(async target => {
    try { await fetch(`${target}/must-not-arrive`, { method: 'POST', body: 'write' }); return false; }
    catch { return true; }
  }, f.config.target);
  assert.equal(refused, true); assert.ok(!f.calls.some(call => call.path === '/must-not-arrive'));
  f.ingress.revoke();
  assert.equal((await page.goto(`${f.config.origin}/after-revoke`)).status(), 410);
  assert.ok(!f.calls.some(call => call.path === '/after-revoke'));
});
