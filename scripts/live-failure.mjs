// Physical owner and gateway loss through the native checklist browser client.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from './guestbook-browser.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { context } from './queue-probe/context.mjs';
const probe = await context('slot-2', process.argv[2]);
assert.match(probe.config.name, /^fogd-m11b[a-z0-9-]*$/);
const states = async (hosts = probe.slot.nodes) => JSON.parse(await probe.node(`console.log(JSON.stringify(await Promise.all(${JSON.stringify(hosts)}.map(async host => ({host,state:await (await fetch('http://'+host+':8081/state')).json()})))))`));
const running = async target => {
  const id = (await probe.compose(['ps', '-a', '-q', target])).trim();
  assert.ok(id && !id.includes('\n'));
  return JSON.parse(await execute('docker', ['inspect', '--format', '{{json .State.Running}}', id]));
};
const before = await states();
const known = new Set(before.flatMap(s => s.state.residents));
const room = `failure-${randomUUID()}`;
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP checklist.localhost 127.0.0.1'] });
const events = [], failures = [];
let stopped = null;
try {
  const page = await browser.newPage();
  page.on('websocket', socket => {
    events.push({ event: 'created', at: Date.now() });
    socket.on('close', () => events.push({ event: 'closed', at: Date.now() }));
  });
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.closeEvents = []; window.openEvents = []; window.snapshotEvents = [];
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args);
        this.addEventListener('open', () => window.openEvents.push({ at: Date.now() }));
        this.addEventListener('close', e => window.closeEvents.push({ code: e.code, reason: e.reason, at: Date.now() }));
        this.addEventListener('message', e => { if (JSON.parse(e.data).type === 'snapshot') window.snapshotEvents.push({ at: Date.now() }); });
      }
    };
  });
  await page.goto(`http://checklist.localhost:${probe.env.FOGD_HTTP_PORT}/?room=${room}`);
  const status = page.getByRole('status');
  await expect(status).toHaveText('Connected · Revision 0 · 0 pending');
  await page.getByLabel('New item').fill('Acknowledged before process loss');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(status).toHaveText('Connected · Revision 1 · 0 pending');
  const observed = await states();
  const candidates = observed.flatMap(s => s.state.residents.filter(id => !known.has(id)).map(id => ({ host: s.host, id })));
  assert.equal(candidates.length, 1, 'Exactly one new room must identify the owner; run without concurrent fixture traffic');
  const owner = candidates[0];
  assert.ok(observed.find(s => s.host === owner.host).state.published.includes(owner.id));
  for (const target of [owner.host, 'workerd']) {
    const start = Date.now();
    stopped = target;
    await probe.compose(['kill', '-s', 'SIGKILL', target]);
    assert.equal(await running(target), false);
    if (target === 'workerd') await probe.compose(['start', target]);
    await expect.poll(() => page.evaluate(start => window.closeEvents.some(e => e.at >= start), start), { timeout: 30000 }).toBe(true);
    await expect.poll(() => page.evaluate(start => window.snapshotEvents.some(e => e.at >= start), start), { timeout: 120000 }).toBe(true);
    await expect(status).toHaveText(`Connected · Revision ${failures.length + 1} · 0 pending`, { timeout: 120000 });
    await page.getByLabel('New item').fill(`After ${target} loss`);
    await page.getByRole('button', { name: 'Add item', exact: true }).click();
    const revision = failures.length + 2;
    await expect(status).toHaveText(`Connected · Revision ${revision} · 0 pending`, { timeout: 120000 });
    await expect(page.getByLabel('Acknowledged before process loss', { exact: true })).toBeVisible();
    const elapsedMs = Date.now() - start;
    const runningAtAcknowledgment = await running(target);
    assert.equal(runningAtAcknowledgment, target === 'workerd');
    let survivor = null;
    if (target === owner.host) {
      [survivor] = await states(probe.slot.nodes.filter(host => host !== owner.host));
      assert.ok(survivor.state.residents.includes(owner.id));
      assert.ok(survivor.state.published.includes(owner.id));
      survivor = { host: survivor.host, residents: survivor.state.residents, published: survivor.state.published };
    }
    const transport = await page.evaluate(start => ({ firstClose: window.closeEvents.find(e => e.at >= start), opened: window.openEvents.filter(e => e.at >= start), firstSnapshot: window.snapshotEvents.find(e => e.at >= start) }), start);
    failures.push({ target, killAt: start, acknowledgmentObservedAt: start + elapsedMs, elapsedMs, revision, runningAtAcknowledgment, survivor, transport });
    await probe.compose(['start', target]); stopped = null;
    if (target !== 'workerd') {
      await expect.poll(async () => { try { return (await states()).length; } catch { return 0; } }, { timeout: 60000 }).toBe(2);
    }
  }
  const snapshot = await page.evaluate(async room => (await fetch(`/rooms/${room}`)).json(), room);
  assert.equal(snapshot.revision, 3); assert.equal(snapshot.items.length, 3);
  await probe.save('failure', { room, owner, workerdImage: probe.config.services.workerd.image, ownerBeforeKill: observed.map(s => ({host:s.host,residents:s.state.residents,published:s.state.published})), failures, events, closeEvents: await page.evaluate(() => window.closeEvents), snapshot, scope: 'Actual owning celld SIGKILL with survivor acknowledgment before owner restart; followed by workerd SIGKILL/restart; ingress node for the owner leg is unknown and may equal owner; separate non-owning ingress loss and idle eviction remain open' });
  console.log('PASS: owning celld process loss preserves acknowledged board and survivor accepts next edit; workerd restart reconnects');
} finally {
  if (stopped) await probe.compose(['start', stopped]);
  await browser.close();
}
