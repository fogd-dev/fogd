// Browser/HTTP wiring proof with a runtime stand-in, not celld qualification.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from './guestbook-browser.mjs';
import { fixture } from '../packages/platform/test/fixtures/queue-controller.mjs';
import { server } from '../packages/platform/src/http.mjs';

assert.ok(process.argv[2], 'Supply a new evidence directory');
const output = resolve(process.argv[2]); await mkdir(output, { mode: 0o700 });
const cleanups = [], f = await fixture({ after: fn => cleanups.push(fn) });
const old = await f.request(); f.fail('publish'); await f.c.mutate(old.id, old.digest, 'approve');
assert.equal(old.status, 'failed'); const next = await f.request();
for (const request of [old, next]) { request.submitter = 'qualification-fixture'; request.submittedAt = new Date().toISOString(); }
await f.c.save();
const http = server(f.c, { user: 'probe', password: 'qualification', deploy: 'fixture', gateway: 'fixture-gateway' });
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise(resolve => http.close(resolve)));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ httpCredentials: { username: 'probe', password: 'qualification' } });
  const origin = `http://127.0.0.1:${http.address().port}`; await page.goto(origin);
  const button = page.locator(`button[data-id="${next.id}"][data-action="approve"]`);
  await expect(button).toHaveText('Approve replacement');
  await expect(button).toHaveAttribute('data-replaces', old.id);
  const submitted = page.waitForRequest(request => request.url() === `${origin}/v1/deployments/${next.id}/approve`);
  const response = page.waitForResponse(response => response.url() === `${origin}/v1/deployments/${next.id}/approve`);
  await button.click(); const result = await response;
  assert.equal(result.status(), 200); const body = (await submitted).postDataJSON();
  assert.equal(body.digest, next.digest); assert.deepEqual(body.replaces, { deployment: old.id, digest: old.digest });
  assert.equal(f.c.state.deployments[next.id].status, 'active');
  await expect(page.getByRole('heading', { name: 'imports — active', exact: true })).toBeVisible();
  await page.screenshot({ path: join(output, 'replacement.png'), fullPage: true });
} finally { await browser.close(); for (const cleanup of cleanups.reverse()) await cleanup(); }
await writeFile(join(output, 'browser.json'), JSON.stringify({ transport: 'real browser and HTTP controller with runtime stand-in', replacementApprovalSubmittedBothIdentities: true, status: 'active' }, null, 2) + '\n');
console.log('PASS: browser replacement approval carries both exact identities through the actual HTTP handler (runtime stand-in)');
