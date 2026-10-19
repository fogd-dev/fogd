// Native Void socket preservation across actual local celld idle eviction.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, expect } from './guestbook-browser.mjs';
import { context } from './queue-probe/context.mjs';
import { run, stackRoot } from '../packages/cli/src/local.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { composeArgs } from '../packages/cli/src/recovery/docker.mjs';
const probe = await context(process.env.FOGD_LIVE_SLOT || 'slot-1', process.argv[2]);
const app = process.env.FOGD_LIVE_APP || 'live-probe';
assert.ok(['live-probe', 'checklist'].includes(app));
assert.match(probe.config.name, /^fogd-m11b[a-z0-9-]*$/);
const config = structuredClone(probe.config);
for (const host of probe.slot.nodes) config.services[host].environment.CELLD_IDLE_EVICT_S = '5';
const file = join(probe.output, 'idle-compose.json');
await writeFile(file, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
const states = async () => JSON.parse(await probe.node(`console.log(JSON.stringify(await Promise.all(${JSON.stringify(probe.slot.nodes)}.map(async host => ({host,state:await (await fetch('http://'+host+':8081/state')).json()})))))`));
const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${app}.localhost 127.0.0.1`] });
let changed = false;
try {
  await healthy();
  const ordinary = await observeOrdinary();
  changed = true;
  await execute('docker', [...composeArgs(file, config.name), 'up', '-d', '--no-deps', '--force-recreate', ...probe.slot.nodes], { env: probe.env });
  await healthy();
  const appliedIdleSeconds = {};
  for (const host of probe.slot.nodes) {
    appliedIdleSeconds[host] = (await probe.compose(['exec', '-T', host, 'printenv', 'CELLD_IDLE_EVICT_S'])).trim();
    assert.equal(appliedIdleSeconds[host], '5');
  }
  const before = await states(), known = new Set(before.flatMap(s => s.state.residents));
  const page = await browser.newPage(), room = `idle-${randomUUID()}`;
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    window.sockets = []; window.closes = [];
    window.WebSocket = class extends Native {
      constructor(...args) { super(...args); window.sockets.push(this); this.addEventListener('close', e => window.closes.push({ code: e.code, at: Date.now() })); }
    };
  });
  await page.goto(`http://${app}.localhost:${probe.env.FOGD_HTTP_PORT}/?room=${room}`);
  const status = page.getByRole('status');
  await expect(status).toHaveText('Connected · Revision 0 · 0 pending');
  await page.getByLabel('New item').fill('Before idle eviction');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(status).toHaveText('Connected · Revision 1 · 0 pending');
  const active = await states();
  const candidates = active.flatMap(s => s.state.residents.filter(id => !known.has(id)).map(id => ({host:s.host,id})));
  assert.equal(candidates.length, 1, 'Run on an otherwise idle fixture');
  const owner = candidates[0], idleAt = Date.now();
  let evicted;
  await expect.poll(async () => {
    evicted = await states();
    return evicted.every(s => !s.state.residents.includes(owner.id));
  }, { timeout: 60000, intervals: [1000] }).toBe(true);
  const evictionObservedAt = Date.now();
  assert.ok(evictionObservedAt - idleAt < 15000, 'Expected idle eviction within 15 seconds');
  assert.ok(evicted.find(s => s.host === owner.host).state.phases.dormant >= 1);
  assert.deepEqual(await page.evaluate(() => ({ count: window.sockets.length, states: window.sockets.map(s => s.readyState), closes: window.closes })), { count: 1, states: [1], closes: [] });
  await page.getByLabel('Before idle eviction', { exact: true }).click();
  await expect(status).toHaveText('Connected · Revision 2 · 0 pending');
  await expect(page.getByLabel('Before idle eviction', { exact: true })).toBeChecked();
  const acknowledgmentObservedAt = Date.now(), restored = await states();
  const restoredOwners = restored.filter(s => s.state.residents.includes(owner.id));
  assert.equal(restoredOwners.length, 1);
  const socketObservation = await page.evaluate(() => ({ count: window.sockets.length, closes: window.closes }));
  assert.deepEqual(socketObservation, { count: 1, closes: [] });
  const snapshot = await page.evaluate(async room => (await fetch(`/rooms/${room}`)).json(), room);
  assert.equal(snapshot.revision, 2); assert.equal(snapshot.items.length, 1); assert.equal(snapshot.items[0].checked, true);
  await probe.save('idle', { room, ordinary, appliedIdleSeconds, idleSeconds: 5, owner, restoredOwner: restoredOwners[0].host, moved: restoredOwners[0].host !== owner.host, idleAt, evictionObservedAt, acknowledgmentObservedAt, evicted: evicted.map(s => ({host:s.host,residents:s.state.residents,phases:s.state.phases})), restored: restored.map(s => ({host:s.host,residents:s.state.residents})), snapshot, socketObservation, scope: 'Ordinary policy holds one socket for 30 seconds; explicit five-second idle eviction restores native Void attachment on one preserved socket; no unbounded-idle or room-move claim' });
  if (process.env.FOGD_LIVE_UPDATE_AFTER_IDLE === '1') {
    assert.equal(probe.slot.id, 'slot-2'); assert.equal(app, 'checklist');
    const log = await run(process.execPath, [join(stackRoot, 'scripts/live-update.mjs'), join(probe.output, 'update')], { env: { ...probe.env, FOGD_COMPOSE_FILE: file, FOGD_LIVE_IDLE_UPDATE: '1' }, capture: true });
    await writeFile(join(probe.output, 'update.log'), log, { mode: 0o600 });
  }
  console.log('PASS: native Void socket and room attachment survive observed celld idle eviction');
} finally {
  await rm(file, { force: true });
  await browser.close();
  if (changed) {
    await probe.compose(['up', '-d', '--no-deps', '--force-recreate', ...probe.slot.nodes]);
    await healthy();
  }
}

async function observeOrdinary() {
  for (const host of probe.slot.nodes) assert.equal(probe.config.services[host].environment.CELLD_IDLE_EVICT_S, undefined, 'Ordinary observation requires the default idle policy');
  const page = await browser.newPage(), room = `ordinary-${randomUUID()}`;
  let sockets = 0, closes = 0;
  page.on('websocket', socket => { sockets++; socket.on('close', () => closes++); });
  try {
    await page.goto(`http://${app}.localhost:${probe.env.FOGD_HTTP_PORT}/?room=${room}`);
    await expect(page.getByRole('status')).toHaveText('Connected · Revision 0 · 0 pending');
    const start = Date.now();
    await expect.poll(() => Date.now() - start, { timeout: 35000, intervals: [1000] }).toBeGreaterThanOrEqual(30000);
    assert.equal(sockets, 1); assert.equal(closes, 0);
    await page.getByLabel('New item').fill('After ordinary idle observation');
    await page.getByRole('button', { name: 'Add item', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Connected · Revision 1 · 0 pending');
    assert.equal(sockets, 1); assert.equal(closes, 0);
    return { room, observationMs: Date.now() - start, sockets, closes, revision: 1 };
  } finally { await page.close(); }
}

async function healthy() {
  await expect.poll(async () => {
    try {
      return JSON.parse(await probe.node(`console.log(JSON.stringify(await Promise.all(${JSON.stringify(probe.slot.nodes)}.map(async host => (await fetch('http://'+host+':8080/.well-known/celld/health',{signal:AbortSignal.timeout(2000)})).status))))`));
    } catch { return []; }
  }, { timeout: 60000 }).toEqual([200, 200]);
}
