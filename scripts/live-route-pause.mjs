// Hold real activation at replica readiness; never inject a controller pause.
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from './http.mjs';
import { expect } from './guestbook-browser.mjs';
import { execute } from '../packages/cli/src/recovery/execute.mjs';
import { composeArgs } from '../packages/cli/src/recovery/docker.mjs';

export async function prepareRoutePause(probe, page, owner) {
  const other = probe.slot.nodes.find(host => host !== owner.host);
  const file = join(probe.output, 'route-pause-compose.json');
  const config = structuredClone(probe.config), slots = JSON.parse(config.services.workerd.environment.FOGD_SLOTS);
  slots.find(slot => slot.id === probe.slot.id).nodes = [owner.host, other];
  config.services.workerd.environment.FOGD_SLOTS = JSON.stringify(slots);
  await writeFile(file, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  let changed = false, paused = false;
  const cleanup = async () => {
    const errors = [];
    for (const action of [
      async () => { if (paused) { await probe.compose(['unpause', other]); paused = false; } },
      () => rm(file, { force: true }),
      async () => { if (changed) await probe.compose(['up', '-d', '--no-deps', '--force-recreate', 'workerd']); },
    ]) { try { await action(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'Route-pause cleanup failed');
  };
  try {
    const count = await page.evaluate(() => window.sockets.length);
    changed = true;
    await execute('docker', [...composeArgs(file, config.name), 'up', '-d', '--no-deps', '--force-recreate', 'workerd'], { env: probe.env });
    await expect.poll(() => page.evaluate(before => window.sockets.length > before && window.sockets.at(-1).readyState === 1, count), { timeout: 60000 }).toBe(true);
    await expect(page.getByRole('status')).toHaveText('Connected · Revision 1 · 0 pending');
    // The intentional setup reconnect precedes the activation under test.
    const setup = await page.evaluate(() => {
      const setup = { count: window.sockets.length, closes: window.closes };
      window.sockets = [window.sockets.at(-1)]; window.closes = [];
      return setup;
    });
    return { cleanup, async approve(cli, admin, update, room, itemId) {
      let approval, primaryError;
      try {
        const residency = JSON.parse(await probe.node(`console.log(JSON.stringify(await Promise.all(${JSON.stringify(probe.slot.nodes)}.map(async host => ({host,state:await (await fetch('http://'+host+':8081/state')).json()})))))`));
        assert.ok(residency.find(s => s.host === owner.host).state.residents.includes(owner.id));
        assert.ok(!residency.find(s => s.host === other).state.residents.includes(owner.id));
        paused = true; await probe.compose(['pause', other]);
        const heldAt = Date.now();
        // Attach rejection handling immediately, including if an assertion fails.
        approval = cli(['admin', 'approve', update.id, update.digest]).then(value => ({ value }), error => ({ error }));
        await expect.poll(async () => {
          const state = await admin();
          return state.apps.checklist.route === 'paused' && state.deployments[update.id].step === 'waiting-for-replicas';
        }, { timeout: 60000, intervals: [100] }).toBe(true);
        const before = await admin();
        const http = await page.evaluate(async room => { const r = await fetch(`/rooms/${room}`); return { status: r.status, body: await r.text() }; }, room);
        assert.deepEqual(http, { status: 503, body: 'App activation paused' });
        const response = await request(`http://127.0.0.1:${probe.env.FOGD_HTTP_PORT}/rooms/${room}`, { headers: { Host: `checklist.localhost:${probe.env.FOGD_HTTP_PORT}`, Origin: `http://checklist.localhost:${probe.env.FOGD_HTTP_PORT}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }, signal: AbortSignal.timeout(5000) });
        const upgradeResponse = { status: response.status, body: await response.text() };
        assert.deepEqual(upgradeResponse, http);
        // Use a fresh page so the rejected upgrade does not affect original-client counters.
        const observer = await page.context().browser().newPage();
        let upgrade;
        try {
          await observer.goto(`http://checklist.localhost:${probe.env.FOGD_HTTP_PORT}/rooms/${room}`);
          upgrade = await observer.evaluate(room => new Promise(resolve => {
            const socket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/rooms/${room}`);
            const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 5000);
            socket.onopen = () => { clearTimeout(timer); socket.close(); resolve('opened'); };
            socket.onerror = () => { clearTimeout(timer); resolve('refused'); };
          }), room);
        } finally { await observer.close(); }
        assert.equal(upgrade, 'refused');
        await page.evaluate(itemId => window.sockets[0].send(JSON.stringify({ type: 'operation', opId: 'during-route-pause', operation: { kind: 'set', itemId, checked: true } })), itemId);
        await expect.poll(() => page.evaluate(() => window.messages.find(m => m.opId === 'during-route-pause')?.type), { timeout: 10000 }).toBe('ack');
        const ack = await page.evaluate(() => window.messages.find(m => m.opId === 'during-route-pause'));
        assert.equal(ack.revision, 2);
        assert.ok(['v1', 'v2'].includes(ack.release));
        const ownerDeployment = await probe.deployment(owner.host);
        const after = await admin(); assert.equal(after.apps.checklist.route, 'paused');
        const id = (await probe.compose(['ps', '-a', '-q', other])).trim();
        assert.equal((await execute('docker', ['inspect', '--format', '{{.State.Paused}}', id])).trim(), 'true');
        assert.deepEqual(await page.evaluate(() => ({ count: window.sockets.length, closes: window.closes })), { count: 1, closes: [] });
        return { owner, residency: residency.map(s => ({ host: s.host, residents: s.state.residents, published: s.state.published })), frozenReplica: other, setup, heldAt, checkedAt: Date.now(), beforeStep: before.deployments[update.id].step, afterStep: after.deployments[update.id].step, http, upgradeResponse, upgrade, ack, ownerDeployment, controllerNodeOrder: probe.slot.nodes };
      } catch (error) { primaryError = error; throw error; } finally {
        const failures = primaryError ? [primaryError] : [];
        try { if (paused) { await probe.compose(['unpause', other]); paused = false; } } catch (error) { failures.push(error); }
        if (approval) { const result = await approval; if (result.error) failures.push(result.error); }
        if (failures.length > (primaryError ? 1 : 0)) throw new AggregateError(failures, 'Route-pause assertion or approval cleanup failed');
      }
    } };
  } catch (error) { await cleanup(); throw error; }
}

export async function freshRoomSnapshot(page, room) {
  const observer = await page.context().browser().newPage();
  try {
    await observer.goto(new URL(`/rooms/${room}`, page.url()).href);
    return await observer.evaluate(room => new Promise((resolve, reject) => {
      const socket = new WebSocket(`${location.origin.replace('http:', 'ws:')}/rooms/${room}`);
      const timer = setTimeout(() => { socket.close(); reject(Error('Fresh socket snapshot timeout')); }, 10000);
      socket.onerror = () => { clearTimeout(timer); reject(Error('Fresh socket refused')); };
      socket.onmessage = event => { clearTimeout(timer); socket.close(1000); resolve(JSON.parse(event.data)); };
    }), room);
  } finally { await observer.close(); }
}
