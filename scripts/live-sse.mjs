// Native Void SSE observer, authoritative room snapshots, and missed-event recovery.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { context } from './queue-probe/context.mjs';
import { chromium, expect } from './guestbook-browser.mjs';
const probe = await context('slot-2', process.argv[2]);
assert.match(probe.config.name, /^fogd-m11b[a-z0-9-]*$/);
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP checklist.localhost 127.0.0.1'] });
let watcher;
try {
  const writer = await browser.newPage(); watcher = await browser.newPage();
  const room = `sse-${randomUUID()}`, origin = `http://checklist.localhost:${probe.env.FOGD_HTTP_PORT}`;
  const errors = [];
  watcher.on('pageerror', error => errors.push(error.message));
  await watcher.addInitScript(() => {
    const Native = window.EventSource; window.liveEvents = [];
    window.EventSource = class extends Native {
      constructor(...args) {
        super(...args);
        for (const type of ['open', 'error', 'message']) this.addEventListener(type, e => window.liveEvents.push({ type, at: Date.now(), ...(type === 'message' ? { data: JSON.parse(e.data) } : {}) }));
      }
    };
  });
  await writer.goto(`${origin}/?room=${room}`);
  await expect(writer.getByRole('status')).toHaveText('Connected · Revision 0 · 0 pending');
  await watcher.goto(`${origin}/watch?room=${room}`);
  await expect(watcher.getByRole('status')).toHaveText('Live · Revision 0', { timeout: 30000 });
  async function add(text, revision) {
    await writer.getByLabel('New item').fill(text);
    await writer.getByRole('button', { name: 'Add item', exact: true }).click();
    await expect(writer.getByRole('status')).toHaveText(`Connected · Revision ${revision} · 0 pending`);
  }
  await add('Observed through live hint', 1);
  await expect(watcher.getByRole('status')).toHaveText('Live · Revision 1', { timeout: 30000 });
  assert.ok(await watcher.evaluate(() => window.liveEvents.some(e => e.type === 'message' && e.data.data.revision === 1)));
  await watcher.route('**/live?*', route => route.abort());
  await probe.compose(['restart', 'workerd']);
  await expect.poll(() => watcher.evaluate(() => window.liveEvents.some(e => e.type === 'error')), { timeout: 30000 }).toBe(true);
  await add('Written while observer offline', 2);
  const reconnectAt = Date.now();
  await watcher.unroute('**/live?*');
  await expect(watcher.getByRole('status')).toHaveText('Live · Revision 2', { timeout: 60000 });
  await expect(watcher.getByRole('list', { name: 'Checklist' })).toContainText('Written while observer offline');
  const idleSeconds = Number(process.env.FOGD_LIVE_SSE_IDLE_SECONDS || 0);
  assert.ok(idleSeconds === 0 || (Number.isInteger(idleSeconds) && idleSeconds >= 15 && idleSeconds <= 60));
  let idle = null;
  if(idleSeconds) {
    const before = await watcher.evaluate(() => window.liveEvents);
    const startedAt = Date.now();
    await watcher.waitForTimeout(idleSeconds * 1000);
    await add('After finite SSE idle observation', 3);
    await expect(watcher.getByRole('status')).toHaveText('Live · Revision 3', { timeout: 30000 });
    idle = { seconds: idleSeconds, startedAt, acknowledgedAt: Date.now(), priorEventCount: before.length };
  }
  const events = await watcher.evaluate(() => window.liveEvents);
  assert.ok(events.some(e => e.type === 'open' && e.at >= reconnectAt));
  assert.deepEqual(errors, []);
  await probe.save('sse', { room, events, errors, reconnectAt, idle, observedItems: await watcher.getByRole('list', { name: 'Checklist' }).innerText(), scope: 'Native SSE hint and missed-notification reconciliation through workerd; finite idle is recorded only when enabled; deployment cancellation and registration race remain open' });
  console.log('PASS: native SSE observes edits and repairs missed notification after reconnect');
} catch (error) {
  await probe.save('failure', { error: error.message, events: watcher ? await watcher.evaluate(() => window.liveEvents).catch(() => []) : [] });
  throw error;
} finally { await browser.close(); }
