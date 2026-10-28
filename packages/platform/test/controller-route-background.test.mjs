import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture as queueFixture } from './fixtures/queue-controller.mjs';
import { fixture as cronFixture } from './fixtures/cron-controller.mjs';
import { authorityFixture } from './fixtures/route-authority.mjs';
import { operateDispatch, dispatchView } from '../src/admin-dispatch.mjs';
import { operateDelivery, deliveryView } from '../src/admin-delivery.mjs';

for (const [name, fixture, operate, view, paused] of [
  ['imports', queueFixture, operateDelivery, deliveryView, f => f.paused()],
  ['refresh', cronFixture, operateDispatch, dispatchView, async f => (await f.runtime()).paused],
]) {
  test(`${name} background resume is independent of a plain durable HTTP pause`, async t => {
    const authority = await authorityFixture(t), f = await fixture(t, { routeAuthority: authority.options });
    const request = await f.request(); await f.c.mutate(request.id, request.digest, 'approve');
    const selected = { deployment: request.id, digest: request.digest };
    await operate(f.c, name, 'pause'); await f.c.decideRoute(name, 'pause', selected);
    const restored = f.create(); await restored.init();
    assert.equal(view(restored, name).resumeAllowed, true);
    await assert.rejects(operate(restored, name, 'resume', { ...selected, digest: '0'.repeat(64) }), /changed/);
    assert.equal(await paused(f), true);
    await operate(restored, name, 'resume', selected);
    assert.equal(await paused(f), false);
    assert.equal((await authority.record()).routes[0].state, 'withheld');
    assert.equal(restored.state.apps[name].route, 'paused');
    await operate(restored, name, 'pause'); assert.equal(await paused(f), true);
  });
  test(`${name} legacy HTTP pause still blocks background resume`, async t => {
    const f = await fixture(t), request = await f.request();
    await f.c.mutate(request.id, request.digest, 'approve'); await operate(f.c, name, 'pause');
    f.c.state.apps[name].route = 'paused'; await f.c.save();
    assert.equal(view(f.c, name).resumeAllowed, false);
    await assert.rejects(operate(f.c, name, 'resume', { deployment: request.id, digest: request.digest }), /completed activation/);
    assert.equal(await paused(f), true);
  });
  test(`${name} background resume still refuses a failed HTTP verification hold`, async t => {
    const authority = await authorityFixture(t, async () => { throw new Error('Runtime unavailable'); });
    const f = await fixture(t, { routeAuthority: authority.options }), request = await f.request();
    await f.c.mutate(request.id, request.digest, 'approve');
    const selected = { deployment: request.id, digest: request.digest };
    await operate(f.c, name, 'pause'); await f.c.decideRoute(name, 'pause', selected);
    await assert.rejects(f.c.decideRoute(name, 'resume', selected), /uncertain/);
    assert.equal(f.c.state.routeAuthority.holds[name].id, request.id);
    assert.equal(view(f.c, name).resumeAllowed, false);
    await assert.rejects(operate(f.c, name, 'resume', selected), /completed activation/);
    assert.equal(await paused(f), true);
    assert.equal((await authority.record()).routes[0].state, 'withheld');
  });
}

for (const [name, fixture] of [['queue', queueFixture], ['cron', cronFixture]]) test(`${name} activation effects run only behind public withholding`, async t => {
  const authority = await authorityFixture(t), f = await fixture(t, { routeAuthority: authority.options });
  for (const verb of ['claim', 'bootstrap', 'publish', 'ready', 'applied', 'migrate']) {
    const original = f.backend[verb];
    f.backend[verb] = async (...args) => { assert.equal((await authority.record()).routes[0]?.state, 'withheld', verb); return original(...args); };
  }
  const request = await f.request(); await f.c.mutate(request.id, request.digest, 'approve');
  assert.equal(request.status, 'active'); assert.equal((await authority.record()).routes[0].submission, request.id);
});
for (const when of ['before', 'after']) test(`queue replacement reloads matching HTTP and delivery holds after ${when}-public uncertainty`, async t => {
  const authority = await authorityFixture(t), f = await queueFixture(t, { routeAuthority: authority.options });
  const previous = await f.request(); f.fail('migrate'); await f.c.mutate(previous.id, previous.digest, 'approve');
  const next = await f.request(); authority.fail(when);
  const replaces = { deployment: previous.id, digest: previous.digest };
  await assert.rejects(f.c.mutate(next.id, next.digest, 'approve', undefined, replaces), /uncertain/);
  const saved = JSON.parse(await readFile(join(f.c.dir, 'state.json'), 'utf8'));
  assert.equal(saved.apps.imports.delivery.hold, next.id); assert.equal(saved.routeAuthority.pending.approval.id, next.id);
  const restored = f.create(); await restored.init();
  assert.equal(restored.state.apps.imports.delivery.hold, next.id);
  assert.equal(restored.state.routeAuthority.holds.imports.id, next.id);
  assert.equal((await authority.record()).routes[0].state, 'withheld');
  await restored.mutate(next.id, next.digest, 'approve', undefined, replaces);
  assert.equal((await authority.record()).routes[0].submission, next.id);
});

for (const when of ['before', 'after']) test(`queue replacement preserves compatible stores after ${when}-private-intent failure`, async t => {
  const authority = await authorityFixture(t), f = await queueFixture(t, { routeAuthority: authority.options });
  const previous = await f.request(); f.fail('migrate'); await f.c.mutate(previous.id, previous.digest, 'approve');
  const next = await f.request(), replaces = { deployment: previous.id, digest: previous.digest };
  f.failWrite(state => state.routeAuthority?.pending?.approval?.id === next.id ? when : null);
  await assert.rejects(f.c.mutate(next.id, next.digest, 'approve', undefined, replaces), /uncertain/);
  f.failWrite(null); const restored = f.create(); await restored.init();
  assert.equal(restored.state.apps.imports.delivery.hold, restored.state.routeAuthority.holds.imports.id);
  assert.equal((await authority.record()).routes[0].state, 'withheld');
  await restored.mutate(next.id, next.digest, 'approve', undefined, replaces);
  assert.equal((await authority.record()).routes[0].submission, next.id);
});

test('a corrected cron release can replace an HTTP hold without replacing a native cron activation hold', async t => {
  const authority = await authorityFixture(t, async () => { throw new Error('Runtime unavailable'); });
  const f = await cronFixture(t, { routeAuthority: authority.options }), first = await f.request();
  await f.c.mutate(first.id, first.digest, 'approve');
  await f.c.decideRoute('refresh', 'pause', { deployment: first.id, digest: first.digest });
  await assert.rejects(f.c.decideRoute('refresh', 'resume', { deployment: first.id, digest: first.digest }), /uncertain/);
  assert.equal(f.c.state.apps.refresh.dispatch.hold, null);
  const next = await f.request(); await f.c.mutate(next.id, next.digest, 'approve', undefined, { deployment: first.id, digest: first.digest });
  assert.equal((await authority.record()).routes[0].submission, next.id);
});

test('failure during held queue startup recovery cannot leave backend decisions ready', async t => {
  const authority = await authorityFixture(t), f = await queueFixture(t, { routeAuthority: authority.options });
  const request = await f.request(); f.fail('migrate'); await f.c.mutate(request.id, request.digest, 'approve');
  f.failWrite(state => state.apps?.imports?.delivery?.operation === 'pause' ? 'before' : null);
  const restored = f.create(); await assert.rejects(restored.init(), /metadata write failed/);
  assert.equal(restored.routingStartupComplete, false);
  await assert.rejects(restored.routes.checkReady(), { code: 'ROUTE_STARTUP_UNRECONCILED' });
  assert.equal((await authority.record()).routes[0].state, 'withheld');
});
