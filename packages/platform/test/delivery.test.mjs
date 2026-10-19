import test from 'node:test';
import assert from 'node:assert/strict';
import { Delivery, initialDelivery } from '../src/delivery.mjs';
function fixture(state = initialDelivery('imports', 'first')) {
  let disk = structuredClone(state), running = false;
  const calls = [], writes = [];
  const runtime = {
    async pause() { calls.push('pause'); running = false; return { paused: true }; },
    async resume(_slot, _queue, version) { calls.push(['resume', version]); running = true; return { paused: false }; },
    async status() { calls.push('status'); return { paused: !running }; },
  };
  const options = { state, runtime, slot: {}, async persist(next) { disk = structuredClone(next); writes.push(disk); } };
  return { options, runtime, calls, writes, disk: () => structuredClone(disk), running: () => running, open: () => new Delivery({ ...options, state: disk }) };
}
test('activation hold and operator intent remain separate across activation', async () => {
  const f = fixture(), d = f.open();
  await assert.rejects(d.resume(), /hold/); assert.deepEqual(f.calls, []);
  await d.hold('first');
  assert.equal(d.state.desired, 'running'); assert.equal(d.state.observed, 'paused');
  await d.pause();
  await d.completeActivation('first', 'v1');
  assert.equal(d.state.desired, 'paused'); assert.equal(d.state.hold, null); assert.equal(f.running(), false);
  await d.resume(); assert.equal(f.running(), true);
  await d.hold('second'); assert.equal(d.state.desired, 'running');
  await assert.rejects(d.completeActivation('other', 'v2'), /own/);
  await assert.rejects(d.hold('third'), /owns/);
  await d.completeActivation('second', 'v2');
  assert.deepEqual(f.calls.at(-1), ['resume', 'v2']);
});
test('lost mutation response persists unknown outcome; reload has no effects and explicit retry uses approved version', async () => {
  const f = fixture(), d = f.open(), resume = f.runtime.resume;
  await d.hold('first');
  f.runtime.resume = async (...args) => { await resume(...args); throw Error('lost response'); };
  await assert.rejects(d.completeActivation('first', 'v1'), /lost response/);
  assert.equal(f.running(), true);
  assert.equal(f.disk().operation, 'resume'); assert.equal(f.disk().observed, 'unknown');
  const before = structuredClone(f.calls), recovered = f.open();
  assert.deepEqual(f.calls, before);
  f.runtime.resume = resume;
  assert.equal(recovered.state.hold, 'first');
  await recovered.reconcile();
  assert.equal(f.calls.at(-1), 'pause'); assert.equal(recovered.state.operation, null);
  await recovered.completeActivation('first', 'v1');
  assert.deepEqual(f.calls.at(-1), ['resume', 'v1']); assert.equal(recovered.state.hold, null);
});
test('persistence failures prevent effects and poison the object until disk reload', async () => {
  for (const failAfterEffect of [false, true]) {
    const f = fixture(), persist = f.options.persist;
    f.options.persist = async next => {
      if (!failAfterEffect || next.observed === 'paused') throw Error('disk failed');
      await persist(next);
    };
    const d = f.open();
    await assert.rejects(d.hold('first'), /disk failed/);
    assert.equal(f.calls.length, failAfterEffect ? 1 : 0);
    await assert.rejects(d.reconcile(), /reload/);
    assert.throws(() => d.state, /reload/);
    f.options.persist = persist;
    const restored = f.open(); await restored.reconcile();
    assert.equal(restored.state.observed, 'paused'); assert.equal(restored.state.hold, 'first');
  }
});
test('status observations do not clear holds or silently retry uncertain operations', async () => {
  const f = fixture(), d = f.open();
  f.runtime.pause = async () => { throw Error('unreachable'); };
  await assert.rejects(d.hold('first'), /unreachable/);
  await d.observe();
  assert.equal(d.state.operation, 'pause'); assert.equal(d.state.hold, 'first');
  assert.deepEqual(f.calls, ['status']);
  f.runtime.status = async () => { throw Error('unreachable'); };
  await assert.rejects(d.observe(), /unreachable/);
  assert.equal(f.disk().observed, 'unknown');
});
test('overlapping delivery operations are rejected while intent is being persisted', async () => {
  const f = fixture(), persist = f.options.persist;
  let unblock;
  let first = true;
  f.options.persist = async state => { if (first) { first = false; await new Promise(resolve => { unblock = resolve; }); } await persist(state); };
  const d = f.open(), pending = d.hold('first');
  await assert.rejects(d.pause(), /in progress/);
  unblock(); await pending;
  assert.equal(d.state.observed, 'paused');
});
test('a corrected activation explicitly takes over the failed hold and preserves operator pause', async () => {
  const f = fixture(), d = f.open();
  await d.pause();
  await assert.rejects(d.hold('correction', { replaces: 'wrong' }), /own/);
  await d.hold('correction', { replaces: 'first' });
  assert.equal(d.state.hold, 'correction'); assert.equal(d.state.desired, 'paused');
  await assert.rejects(d.completeActivation('first', 'v1'), /own/);
  await d.completeActivation('correction', 'v2');
  assert.equal(f.running(), false); assert.equal(d.state.version, 'v2');
});
test('an ambiguously committed observation requires reloading the durable journal', async () => {
  const f = fixture(), persist = f.options.persist;
  f.options.persist = async next => { await persist(next); if (next.observed === 'paused') throw Error('directory sync failed'); };
  const d = f.open();
  await assert.rejects(d.hold('first'), /directory sync/);
  assert.throws(() => d.state, /reload/);
  assert.equal(f.disk().observed, 'paused');
  f.options.persist = persist;
  assert.equal(f.open().state.observed, 'paused');
});
test('runtime generation refusal keeps the activation hold until a confirmed retry', async () => {
  const { QueueRuntime } = await import('../src/queue-runtime.mjs');
  const { queueCell } = await import('../src/queue-runtime.mjs');
  const f = fixture(); let version = 'v1', paused = true;
  f.options.slot = { nodes: ['a'] };
  f.options.runtime = new QueueRuntime({
    async run(_slot, args) {
      if (args[1] === 'resume') paused = false;
      if (args[1] === 'pause') paused = true;
      return JSON.stringify({ paused, stored: 0, backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: null });
    },
    async inspect() { return { version, generation: 1, cells: { [queueCell('imports')]: 1 } }; },
  });
  const d = f.open();
  await assert.rejects(d.completeActivation('first', 'v2'), /not confirmed/);
  await d.hold('first');
  await assert.rejects(d.completeActivation('first', 'v2'), /approved runtime version/);
  assert.equal(f.disk().hold, 'first'); assert.equal(f.disk().version, null); assert.equal(paused, true); assert.equal(d.confirmed, false);
  await assert.rejects(d.resume(), /hold/);
  const recovered = f.open(); await recovered.reconcile();
  assert.equal(recovered.confirmed, true); assert.equal(recovered.effective, 'paused');
  version = 'v2'; await recovered.completeActivation('first', 'v2');
  assert.equal(paused, false); assert.equal(recovered.state.hold, null); assert.equal(recovered.confirmed, true);
});
test('a contradictory runtime result cannot become a confirmed journal observation', async () => {
  const f = fixture(), d = f.open();
  f.runtime.pause = async () => ({ paused: false });
  await assert.rejects(d.hold('first'), e => e.code === 'QUEUE_OUTCOME_UNKNOWN');
  assert.equal(d.state.observed, 'unknown'); assert.equal(d.confirmed, false);
});
test('an uncertain activation release can transfer ownership only through a new confirmed pause', async () => {
  const f = fixture(), d = f.open(), resume = f.runtime.resume;
  await d.hold('first');
  f.runtime.resume = async (...args) => { await resume(...args); throw Error('lost'); };
  await assert.rejects(d.completeActivation('first', 'v1'), /lost/);
  assert.equal(f.running(), true); assert.equal(d.state.operation, 'resume');
  await d.hold('correction', { replaces: 'first' });
  assert.equal(f.running(), false); assert.equal(d.state.hold, 'correction');
  assert.equal(d.state.desired, 'running'); assert.equal(d.confirmed, true);
});
test('invalid runtime observations cannot become confirmed', async () => {
  const f = fixture(), d = f.open();
  await d.hold('first');
  f.runtime.status = async () => ({ paused: 'yes' });
  await assert.rejects(d.observe(), /Invalid runtime/);
  assert.equal(f.disk().observed, 'unknown'); assert.equal(d.confirmed, false);
});
test('unknown journal fields fail closed instead of propagating through future writes', () => {
  const f = fixture({ ...initialDelivery('imports', 'first'), unrecognized: true });
  assert.throws(() => f.open(), /Unknown delivery journal field/);
});
