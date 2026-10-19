import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configEnv } from '../packages/cli/src/local.mjs';
import { chromium, expect } from './guestbook-browser.mjs';
const output = resolve(process.argv[2]); await mkdir(output, { mode: 0o700 });
const env = await configEnv(), room = `ui-${randomUUID()}`, origin = `http://checklist.localhost:${env.FOGD_HTTP_PORT}`;
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP checklist.localhost 127.0.0.1'] });
const errors = [], earlyFrames = []; let dropAck = false, droppedId, allowReconnect = true;
try {
  const writerContext = await browser.newContext(), watcherContext = await browser.newContext();
  await writerContext.addInitScript(() => {
    const Native = window.WebSocket; window.testSockets = [];
    window.WebSocket = class extends Native { constructor(...args) { super(...args); window.testSockets.push(this); } };
  });
  await writerContext.routeWebSocket('**/rooms/**', route => {
    if (!allowReconnect) { void route.close({ code: 1012, reason: 'qualification disconnected' }); return; }
    const server = route.connectToServer(); let snapshotDelivered = false;
    route.onMessage(message => { if (!snapshotDelivered) earlyFrames.push(JSON.parse(String(message))); server.send(message); });
    server.onMessage(message => {
      const value = JSON.parse(String(message));
      if (dropAck && value.type === 'ack') {
        dropAck = false; droppedId = value.opId; allowReconnect = false;
        void route.close({ code: 1012, reason: 'qualification lost acknowledgment' }); void server.close(); return;
      }
      if (!snapshotDelivered && value.type === 'snapshot') { setTimeout(() => { snapshotDelivered = true; route.send(message); }, 200); }
      else route.send(message);
    });
  });
  const writer = await writerContext.newPage(), watcher = await watcherContext.newPage();
  for (const page of [writer, watcher]) page.on('pageerror', error => errors.push(error.message));
  await Promise.all([writer.goto(`${origin}/?room=${room}`), watcher.goto(`${origin}/?room=${room}`)]);
  for (const page of [writer, watcher]) await expect(page.getByRole('status')).toContainText('Connected', { timeout: 30000 });
  await writer.getByLabel('New item').fill('Shared browser item'); await writer.getByRole('button', { name: 'Add item' }).click();
  await expect(watcher.getByRole('checkbox', { name: 'Shared browser item' })).toBeVisible();
  await watcher.getByRole('checkbox', { name: 'Shared browser item' }).click();
  await expect(writer.getByRole('checkbox', { name: 'Shared browser item' })).toBeChecked();
  await writer.getByLabel('New item').fill('Closing window');
  allowReconnect = false;
  const closingState = await writer.evaluate(() => {
    const raw = window.testSockets.at(-1); raw.close(1000, 'qualification closing window');
    const state = raw.readyState; document.querySelector('form').requestSubmit(); return state;
  });
  assert.equal(closingState, 2);
  const beforeReconnect = await watcher.evaluate(async room => (await fetch(`/rooms/${room}`)).json(), room);
  assert.equal(beforeReconnect.revision, 2, 'Closing-window write must not reach the server');
  allowReconnect = true;
  await expect(writer.getByRole('checkbox', { name: 'Closing window' })).toBeVisible({ timeout: 30000 });
  await expect(writer.getByRole('status')).toContainText('0 pending');
  assert.deepEqual(earlyFrames, [], 'No operation may precede the initial snapshot');
  dropAck = true;
  await writer.getByLabel('New item').fill('Unknown outcome'); await writer.getByRole('button', { name: 'Add item' }).click();
  await expect.poll(() => droppedId, { timeout: 30000 }).toBeTruthy();
  const saved = await writer.evaluate(room => Object.keys(localStorage).filter(k => k.startsWith(`fogd-checklist:${room}:pending:`)).map(k => JSON.parse(localStorage[k])), room);
  assert.equal(saved.length, 1); assert.equal(saved[0].opId, droppedId);
  await expect(watcher.getByRole('checkbox', { name: 'Unknown outcome' })).toBeVisible();
  const before = await watcher.evaluate(async room => (await fetch(`/rooms/${room}`)).json(), room);
  allowReconnect = true; await writer.reload();
  await expect(writer.getByRole('status')).toContainText('0 pending', { timeout: 30000 });
  await expect(writer.getByRole('checkbox', { name: 'Unknown outcome' })).toBeVisible();
  const after = await writer.evaluate(async room => (await fetch(`/rooms/${room}`)).json(), room);
  assert.deepEqual(after, before); assert.equal(after.items.length, 3); assert.equal(after.revision, 4);
  await writer.evaluate(room => localStorage.setItem(`fogd-checklist:${room}:pending:orphan`, JSON.stringify({ opId: 'orphan', operation: { kind: 'set', itemId: 'missing', checked: true }, order: Date.now() })), room);
  await writer.reload();
  await expect(writer.getByRole('alert')).toContainText('unknown-item', { timeout: 30000 });
  await expect(writer.getByRole('status')).toContainText('0 pending');
  await writer.reload(); await expect(writer.getByRole('status')).toContainText('Connected');
  assert.equal(await writer.getByRole('alert').count(), 0);
  await writer.evaluate(room => {
    localStorage.setItem(`fogd-checklist:${room}:revision`, '100');
    localStorage.setItem(`fogd-checklist:${room}:pending:restore-review`, JSON.stringify({ opId: 'restore-review', operation: { kind: 'add', itemId: 'restored-item', text: 'Accepted restored state' }, order: Date.now() }));
  }, room);
  await writer.reload();
  await expect(writer.getByRole('status')).toContainText('Writes stopped');
  await expect(writer.getByRole('checkbox', { name: 'Unknown outcome' })).toBeVisible();
  const beforeAcceptance = await writer.evaluate(async room => (await fetch(`/rooms/${room}`)).json(), room);
  assert.deepEqual(beforeAcceptance, after, 'Simulated higher browser watermark must prevent pending mutation');
  await writer.getByRole('button', { name: 'Accept restored state and retry pending edits' }).click();
  await expect(writer.getByRole('checkbox', { name: 'Accepted restored state' })).toBeVisible();
  await expect(writer.getByRole('status')).toContainText('0 pending');
  const accepted = await writer.evaluate(async room => (await fetch(`/rooms/${room}`)).json(), room);
  assert.equal(accepted.revision, 5);
  assert.deepEqual(errors, []);
  await writer.screenshot({ path: join(output, 'checklist.png'), fullPage: true });
  await writeFile(join(output, 'browser.json'), JSON.stringify({ project: env.COMPOSE_PROJECT_NAME, room, finalSnapshot: accepted, rollbackGate: { injectedBrowserWatermark: 100, beforeAcceptance: beforeAcceptance.revision, afterAcceptance: accepted.revision }, droppedOperation: droppedId, retainedPendingBeforeReload: saved, rejectionSettled: true, closingState, earlyFrames, errors, transport: 'Real workerd/celld; writer proxy delays first snapshots, suppresses one acknowledgment and closes; watcher connects directly', scope: 'Browser persistence, two users, reload/unknown-outcome replay; node failures, updates, SSE and recovery remain separate' }, null, 2) + '\n', { mode: 0o600 });
  console.log('PASS: two browser checklists converge; a lost acknowledgment survives reload without duplicate mutation; durable rejection settles');
} finally { await browser.close(); }
