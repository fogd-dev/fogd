import test from 'node:test';
import assert from 'node:assert/strict';
import { QueueRuntime, queueCell } from '../src/queue-runtime.mjs';
const cell = queueCell('imports');
const slot = { nodes: ['a', 'b'] };
function fixture() {
  let paused = true;
  const calls = [], states = [{ version: 'approved', generation: 2, cells: { [cell]: 2 } }, { version: 'approved', generation: 3, cells: {} }];
  const adapter = {
    async run(_slot, args) {
      const verb = args[1]; calls.push(verb);
      if (verb === 'resume') paused = false;
      if (verb === 'pause') paused = true;
      return JSON.stringify({ paused, stored: 1, backlogCount: 1, backlogBytes: 12, oldestMessageTimestamp: 1, ignored: 'private' });
    },
    async inspect(node) { calls.push(node); return states[slot.nodes.indexOf(node)]; },
  };
  return { adapter, calls, states, get runtime() { return new QueueRuntime(adapter); } };
}
test('resume observes both approved replicas and confirms state after mutation', async () => {
  const f = fixture();
  const status = await f.runtime.resume(slot, 'imports', 'approved');
  assert.equal(status.paused, false); assert.equal(status.ignored, undefined);
  assert.deepEqual(f.calls, ['info', 'a', 'b', 'resume', 'info']);
  await f.runtime.pause(slot, 'imports');
  assert.deepEqual(f.calls.slice(-2), ['pause', 'info']);
});
test('stale, absent, duplicate or unexpected queue residents block resume', async () => {
  for (const change of [
    f => { f.states[0].cells[cell] = 1; },
    f => { f.states[1].version = 'old'; },
    f => { f.states[0].cells = {}; },
    f => { f.states[0].cells = { [queueCell('other')]: 2 }; },
    f => { f.states[1].cells[cell] = 3; },
    f => { f.states[0].cells['__Queue:other'] = 2; },
    f => { f.states[1] = null; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.runtime.resume(slot, 'imports', 'approved'));
    assert.ok(!f.calls.includes('resume'));
  }
});
test('cold queue is materialized before inspection, unrelated old handlers do not prevent resume', async () => {
  const f = fixture(), run = f.adapter.run;
  f.states[0].cells = {};
  f.states[0].draining = [{ version: 'old', generation: 1 }];
  f.adapter.run = async (...args) => { const result = await run(...args); f.states[0].cells[cell] = 2; return result; };
  await f.runtime.resume(slot, 'imports', 'approved');
  assert.ok(f.calls.includes('resume'));
});
test('unavailable replicas, invalid status and missing approval block mutation', async () => {
  for (const change of [
    f => { f.adapter.inspect = async () => { throw Error('unreachable'); }; },
    f => { f.adapter.run = async () => '{"paused":true}'; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.runtime.resume(slot, 'imports', 'approved'));
    assert.ok(!f.calls.includes('resume'));
  }
  const f = fixture(); await assert.rejects(f.runtime.resume(slot, 'imports', ''));
  assert.deepEqual(f.calls, []);
});
test('uncertain mutation or confirmation fails without silently retrying', async () => {
  for (const failedVerb of ['pause', 'resume', 'confirmation']) {
    const f = fixture(), run = f.adapter.run;
    f.adapter.run = async (...args) => {
      const result = await run(...args);
      if (args[1][1] === failedVerb || (failedVerb === 'confirmation' && f.calls.includes('resume') && args[1][1] === 'info')) throw Error('lost response');
      return result;
    };
    await assert.rejects(failedVerb === 'pause' ? f.runtime.pause(slot, 'imports') : f.runtime.resume(slot, 'imports', 'approved'), e => e.code === 'QUEUE_OUTCOME_UNKNOWN' && /lost response/.test(e.cause.message));
    assert.equal(f.calls.filter(v => v === (failedVerb === 'pause' ? 'pause' : 'resume')).length, 1);
  }
});
test('a successful command without the requested observed state is not confirmation', async () => {
  for (const verb of ['pause', 'resume']) {
    const f = fixture();
    f.adapter.run = async (_slot, args) => {
      f.calls.push(args[1]);
      return JSON.stringify({ paused: verb === 'resume', stored: 0, backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: null });
    };
    await assert.rejects(verb === 'pause' ? f.runtime.pause(slot, 'imports') : f.runtime.resume(slot, 'imports', 'approved'), e => e.code === 'QUEUE_OUTCOME_UNKNOWN' && /not confirmed/.test(e.cause.message));
    assert.deepEqual(f.calls.slice(-2), [verb, 'info']);
  }
});

test('queue identity matches the pinned runtime observation', () => {
  assert.equal(queueCell('imports'), '__Queue:d463c89028a13df148b7c70bcd22af22f372e287302315af0317983de634274b');
});
