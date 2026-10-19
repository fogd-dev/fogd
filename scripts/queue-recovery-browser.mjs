// Browser/HTTP wiring proof with a runtime stand-in, not celld qualification.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, expect } from './guestbook-browser.mjs';
import { fixture } from '../packages/platform/test/fixtures/queue-controller.mjs';
import { server } from '../packages/platform/src/http.mjs';
import { operateDelivery } from '../packages/platform/src/admin-delivery.mjs';
import { recoveryReview, recoverQueueSnapshots } from '../packages/platform/src/queue-recovery.mjs';
import { queueRecoveryCapability } from '../packages/platform/src/queue-snapshot.mjs';

assert.ok(process.argv[2], 'Supply a new evidence directory');
const output = resolve(process.argv[2]); await mkdir(output, { mode: 0o700 });
const cleanups = [], f = await fixture({ after: fn => cleanups.push(fn) });
const deployment = await f.request();
deployment.submitter = 'qualification-fixture'; deployment.submittedAt = new Date().toISOString();
await f.c.mutate(deployment.id, deployment.digest, 'approve');
f.backend.queues.snapshot = async () => ({ paused: true, stored: 0, backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: null });
await operateDelivery(f.c, 'imports', 'snapshot', { deployment: deployment.id, digest: deployment.digest });
const app = f.c.state.apps.imports;
app.queueRecovery = { id: randomUUID(), status: 'pending', snapshot: 'a'.repeat(64), prepared: app.queueSnapshot };
delete app.queueSnapshot; app.route = 'paused'; f.c.state.requirements.push(queueRecoveryCapability); await f.c.save(); await recoverQueueSnapshots(f.c);
const review = recoveryReview(app.queueRecovery);
const http = server(f.c, { user: 'probe', password: 'qualification', deploy: 'fixture', gateway: 'fixture-gateway' });
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise(resolve => http.close(resolve)));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ httpCredentials: { username: 'probe', password: 'qualification' } });
  const origin = `http://127.0.0.1:${http.address().port}`; await page.goto(origin);
  await expect(page.locator('button[data-delivery="resume"]')).toHaveCount(0);
  const button = page.getByRole('button', { name: 'Acknowledge recovery', exact: true });
  page.once('dialog', dialog => dialog.dismiss()); await button.click();
  assert.equal(app.queueRecovery.status, 'pending');
  page.once('dialog', dialog => { assert.match(dialog.message(), /possible expired/); return dialog.accept(); });
  const path = `${origin}/v1/apps/imports/delivery/acknowledge-recovery`;
  const submitted = page.waitForRequest(request => request.url() === path);
  const response = page.waitForResponse(response => response.url() === path);
  await button.click(); assert.equal((await response).status(), 200);
  const body = (await submitted).postDataJSON();
  assert.deepEqual(body, { deployment: deployment.id, digest: deployment.digest, recovery: app.queueRecovery.id, review, acceptPossibleLoss: true });
  await expect(page.locator('button[data-delivery="resume"]')).toBeVisible();
  assert.equal(app.queueRecovery.status, 'acknowledged'); assert.equal(app.delivery.desired, 'paused'); assert.equal(f.paused(), true);
  await page.screenshot({ path: join(output, 'recovered-paused.png'), fullPage: true });
} finally { await browser.close(); for (const cleanup of cleanups.reverse()) await cleanup(); }
await writeFile(join(output, 'browser.json'), JSON.stringify({ transport: 'real browser and HTTP controller with runtime stand-in', cancellationPreservesPendingRecovery: true, acknowledgmentBindsRecoveryAndArtifact: true, deliveryRemainsPaused: true }, null, 2) + '\n');
console.log('PASS: browser acknowledgment binds artifact/recovery identities, requires loss confirmation, and leaves delivery paused (runtime stand-in)');
