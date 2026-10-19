// Server protocol qualification through native rooms and the ordinary approval path.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configEnv, stackRoot, run } from '../packages/cli/src/local.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { chromium, expect } from './guestbook-browser.mjs';
const output = resolve(process.argv[2]); await mkdir(output, { mode: 0o700 });
const env = await configEnv(); assert.match(env.COMPOSE_PROJECT_NAME || '', /^fogd-m11b[a-z0-9-]*$/);
const cli = args => execute(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), ...args], { env });
const auth = { Authorization: `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}` };
async function admin() { const r = await fetch(`http://127.0.0.1:${env.FOGD_ADMIN_PORT}/v1/admin`, { headers: auth }); assert.equal(r.status, 200); return r.json(); }
const credential = JSON.parse(await cli(['admin', 'issue-token', 'live-board-qualification', 'live-probe,checklist']));
const releases = [];
for (const app of ['live-probe', 'checklist']) {
  const before = await admin();
  const log = await run(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), 'deploy', '--name', app], { cwd: join(stackRoot, 'examples/checklist'), env: { ...env, FOGD_DEPLOY_TOKEN: credential.token }, capture: true });
  await writeFile(join(output, `${app}-deploy.log`), log, { mode: 0o600 });
  const added = Object.values((await admin()).deployments).filter(r => !Object.hasOwn(before.deployments, r.id));
  assert.equal(added.length, 1); assert.equal(added[0].app, app); assert.equal(added[0].status, 'pending');
  await cli(['admin', 'approve', added[0].id, added[0].digest]);
  releases.push({ app, id: added[0].id, digest: added[0].digest });
}
const browser = await chromium.launch({ args: ['--host-resolver-rules=MAP live-probe.localhost 127.0.0.1, MAP checklist.localhost 127.0.0.1'] });
const room = `board-${randomUUID()}`;
try {
  const page = await browser.newPage(), origin = `http://live-probe.localhost:${env.FOGD_HTTP_PORT}`;
  assert.equal((await page.goto(`${origin}/rooms/${room}`)).status(), 200);
  await page.evaluate(async ({ origin, room }) => {
    window.probe = { sockets: [], messages: [] };
    for (let i = 0; i < 2; i++) {
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/rooms/${room}`);
        window.probe.sockets.push(socket); const messages = []; window.probe.messages.push(messages);
        const timer = setTimeout(() => reject(Error('Initial snapshot timeout')), 15000);
        socket.onerror = () => reject(Error('WebSocket error'));
        socket.onmessage = e => { const message = JSON.parse(e.data); messages.push(message); if (message.type === 'snapshot') { clearTimeout(timer); resolve(); } };
      });
    }
  }, { origin, room });
  const send = (socket, opId, operation) => page.evaluate(({ socket, opId, operation }) => window.probe.sockets[socket].send(JSON.stringify({ type: 'operation', opId, operation })), { socket, opId, operation });
  const replies = (socket, opId) => page.evaluate(({ socket, opId }) => window.probe.messages[socket].filter(m => m.opId === opId), { socket, opId });
  const waitReply = async (socket, opId, type) => { await expect.poll(async () => (await replies(socket, opId)).at(-1)?.type, { timeout: 30000 }).toBe(type); return (await replies(socket, opId)).at(-1); };
  const firstMessages = await page.evaluate(() => window.probe.messages.map(messages => messages[0]));
  assert.ok(firstMessages.every(message => message.type === 'snapshot' && message.revision === 0));
  const operation = { kind: 'add', itemId: 'first', text: 'Shared checklist' };
  await send(0, 'add', operation); assert.equal((await waitReply(0, 'add', 'ack')).revision, 1);
  await send(1, 'add', operation); assert.equal((await waitReply(1, 'add', 'ack')).revision, 1);
  await send(1, 'conflict', { ...operation, itemId: 'first' }); assert.equal((await waitReply(1, 'conflict', 'rejected')).reason, 'item-exists');
  await send(0, 'add', { ...operation, text: 'Changed payload' }); assert.equal((await waitReply(0, 'add', 'rejected')).reason, 'operation-conflict');
  await Promise.all([send(0, 'set-a', { kind: 'set', itemId: 'first', checked: true }), send(1, 'set-b', { kind: 'set', itemId: 'first', checked: false })]);
  const a = await waitReply(0, 'set-a', 'ack'), b = await waitReply(1, 'set-b', 'ack');
  assert.deepEqual([a.revision, b.revision].sort(), [2, 3]);
  await send(0, 'invalid', { kind: 'add', itemId: 'bad', text: 'x'.repeat(161) });
  assert.equal((await waitReply(0, 'invalid', 'rejected')).reason, 'invalid-operation');
  assert.deepEqual(await page.evaluate(() => window.probe.sockets.map(s => s.readyState)), [1, 1]);
  let snapshot = await page.evaluate(async room => (await fetch(`/rooms/${room}`)).json(), room);
  assert.equal(snapshot.revision, 3); assert.equal(snapshot.items.length, 1); assert.equal(snapshot.items[0].checked, a.revision > b.revision);
  await page.evaluate(() => {
    window.probe.sockets[0].send(JSON.stringify({ type: 'operation', opId: 'closing', operation: { kind: 'add', itemId: 'closing-item', text: 'Sender disconnected' } }));
    window.probe.sockets[0].close(1000, 'close after send');
  });
  await expect.poll(async () => page.evaluate(() => window.probe.messages[1].filter(m => m.type === 'snapshot').at(-1)?.revision), { timeout: 30000 }).toBe(4);
  snapshot = await page.evaluate(async room => (await fetch(`/rooms/${room}`)).json(), room);
  assert.equal(snapshot.items.length, 2);
  assert.equal(await page.evaluate(async () => (await fetch('/rooms/INVALID')).status), 400);
  const other = await browser.newPage();
  await other.goto(`http://checklist.localhost:${env.FOGD_HTTP_PORT}/rooms/${room}`);
  const forbidden = await other.evaluate(origin => new Promise(resolve => {
    const socket = new WebSocket(origin.replace('http:', 'ws:') + '/rooms/forbidden');
    const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 10000);
    socket.onopen = () => { clearTimeout(timer); socket.close(); resolve('opened'); };
    socket.onerror = () => { clearTimeout(timer); resolve('refused'); };
  }), origin);
  assert.equal(forbidden, 'refused');
  const isolated = await other.evaluate(() => JSON.parse(document.body.textContent)); assert.equal(isolated.revision, 0); assert.deepEqual(isolated.items, []);
  const otherRoom = await page.evaluate(async () => (await fetch('/rooms/other-room')).json()); assert.equal(otherRoom.revision, 0);
  await writeFile(join(output, 'protocol.json'), JSON.stringify({ project: env.COMPOSE_PROJECT_NAME, releases, room, snapshot, isolated, concurrentReceipts: [a, b], firstMessages, senderDisconnectPeerRevision: 4, crossOriginUpgrade: forbidden, invalidRoomStatus: 400, socketsStayedOpenAfterRejection: true, scope: 'Real celld SQL transactions and native WebSockets; browser durable outbox and failure recovery not yet implemented' }, null, 2) + '\n', { mode: 0o600 });
  await page.evaluate(() => window.probe.sockets.forEach(s => s.close(1000, 'probe complete')));
  console.log('PASS: native room SQL receipts, conflicts, concurrent edits, typed rejection, and app/room isolation');
} finally { await browser.close(); }
