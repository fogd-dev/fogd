import test from 'node:test';
import assert from 'node:assert/strict';
import { CronRuntime } from '../src/cron-runtime.mjs';

const slot = { nodes: ['a', 'b'] };
function fixture() {
  const control = { paused: true, revision: 2, nextAlarm: null, crons: ['* * * * *'] };
  const states = [{ version: 'approved', generation: 4, cells: { '.cron:refresh': 4 } },
    { version: 'approved', generation: 7, cells: {}, draining: [{ version: 'old', generation: 6 }] }];
  const calls = [];
  const adapter = {
    async verify() {},
    async run(_slot, args) {
      assert.deepEqual([args[0], ...args.slice(2)], ['cron', 'refresh', '--json']);
      const verb = args[1]; calls.push(verb);
      if (verb !== 'info') {
        const paused = verb === 'pause';
        if (paused !== control.paused) control.revision++;
        control.paused = paused;
        control.nextAlarm = paused ? null : 60000;
      }
      return JSON.stringify({ ...control, privateDiagnostic: 'withheld' });
    },
    async inspect(node) { calls.push(node); return states[slot.nodes.indexOf(node)]; },
  };
  return { control, states, calls, adapter, get runtime() { return new CronRuntime(adapter); } };
}

test('cron resume requires approved replicas and the current resident; pause confirms persisted state', async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.resume(slot, 'refresh', 'approved'), {
    paused: false, revision: 3, nextAlarm: 60000, crons: ['* * * * *'],
  });
  assert.deepEqual(f.calls, ['info', 'a', 'b', 'resume', 'info']);
  assert.equal((await f.runtime.pause(slot, 'refresh')).paused, true);
  assert.deepEqual(f.calls.slice(-2), ['pause', 'info']);
});

test('cron resume refuses absent, stale, duplicated or unexpected residents and unavailable replicas', async () => {
  for (const change of [
    f => { f.states[0].cells['.cron:refresh'] = 3; },
    f => { f.states[1].version = 'old'; },
    f => { f.states[0].cells = {}; },
    f => { f.states[0].cells = { '.cron:other': 4 }; },
    f => { f.states[1].cells['.cron:refresh'] = 7; },
    f => { f.states[0].cells['.cron:other'] = 4; },
    f => { f.states[1] = null; },
    f => { f.adapter.inspect = async () => { throw Error('unreachable'); }; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.runtime.resume(slot, 'refresh', 'approved'));
    assert.ok(!f.calls.includes('resume'));
  }
});

test('cron resume materializes a cold held cell before inspecting its generation', async () => {
  const f = fixture(), run = f.adapter.run;
  f.states[0].cells = {};
  f.adapter.run = async (...args) => {
    const result = await run(...args);
    if (args[1][1] === 'info') f.states[0].cells['.cron:refresh'] = 4;
    return result;
  };
  assert.equal((await f.runtime.resume(slot, 'refresh', 'approved')).paused, false);
});

test('cron control rejects malformed runtime status without releasing dispatch', async () => {
  for (const invalid of [
    { paused: 'true' }, { revision: -1 }, { revision: 0.1 }, { revision: null },
    { nextAlarm: undefined }, { nextAlarm: -1 }, { nextAlarm: '60000' },
    { crons: null }, { crons: [''] }, { crons: [1] },
  ]) {
    const f = fixture(); Object.assign(f.control, invalid);
    await assert.rejects(f.runtime.resume(slot, 'refresh', 'approved'));
    assert.ok(!f.calls.includes('resume'));
  }
});

test('invalid script, absent approval and missing or duplicate replicas cause no runtime effects', async () => {
  const f = fixture();
  for (const script of ['', '../refresh', 'refresh:other', '--json', 'x'.repeat(64)]) {
    await assert.rejects(f.runtime.pause(slot, script), error => error.code !== 'CRON_OUTCOME_UNKNOWN' && /Invalid cron script/.test(error.message));
  }
  for (const nodes of [[], ['a', 'a'], undefined, [null], ['']]) {
    await assert.rejects(f.runtime.resume({ nodes }, 'refresh', 'approved'));
  }
  await assert.rejects(f.runtime.resume(slot, 'refresh', ''));
  assert.deepEqual(f.calls, []);
});

test('lost cron command or confirmation responses remain uncertain without automatic retry', async () => {
  for (const verb of ['pause', 'resume']) for (const boundary of ['command', 'confirmation']) {
    const f = fixture(), run = f.adapter.run;
    f.control.paused = verb === 'resume';
    f.adapter.run = async (...args) => {
      const result = await run(...args);
      if (boundary === 'command' ? args[1][1] === verb : args[1][1] === 'info' && f.calls.includes(verb)) throw Error('lost response');
      return result;
    };
    await assert.rejects(verb === 'pause' ? f.runtime.pause(slot, 'refresh') : f.runtime.resume(slot, 'refresh', 'approved'),
      error => error.code === 'CRON_OUTCOME_UNKNOWN' && error.cause.message === 'lost response');
    assert.equal(f.calls.filter(value => value === verb).length, 1);
    assert.equal(f.control.paused, verb === 'pause', 'The mutation committed even though its outcome was not confirmed');
  }
});

test('opposite state or regressed revision after a successful command is not confirmation', async () => {
  for (const change of [control => { control.paused = true; }, control => { control.revision = 1; }]) {
    const f = fixture(), run = f.adapter.run;
    f.adapter.run = async (...args) => {
      if (args[1][1] === 'info' && f.calls.includes('resume')) change(f.control);
      return run(...args);
    };
    await assert.rejects(f.runtime.resume(slot, 'refresh', 'approved'), { code: 'CRON_OUTCOME_UNKNOWN' });
  }
});

test('cron status exposes only the control observation, excluding runtime diagnostics', async () => {
  const f = fixture();
  const observed = await f.runtime.status(slot, 'refresh');
  assert.deepEqual(Object.keys(observed).sort(), ['crons', 'nextAlarm', 'paused', 'revision']);
  assert.equal(observed.nextAlarm, null);
});

test('pause cannot confirm a held state with an armed alarm', async () => {
  const f = fixture(), run = f.adapter.run;
  f.adapter.run = async (...args) => {
    const result = JSON.parse(await run(...args));
    return JSON.stringify({ ...result, nextAlarm: 60000 });
  };
  await assert.rejects(f.runtime.pause(slot, 'refresh'), { code: 'CRON_OUTCOME_UNKNOWN' });
});

test('an empty bootstrap schedule cannot be released before application publication', async () => {
  const f = fixture(); f.control.crons = [];
  await assert.rejects(f.runtime.resume(slot, 'refresh', 'approved'), { code: 'CRON_EMPTY_SCHEDULE' });
  assert.equal(f.control.paused, true);
  assert.deepEqual(f.calls, ['info']);
});

test('a command reply contradicting resume leaves the outcome uncertain', async () => {
  const f = fixture(), run = f.adapter.run;
  f.adapter.run = async (...args) => {
    const result = JSON.parse(await run(...args));
    if (args[1][1] === 'resume') result.paused = true;
    return JSON.stringify(result);
  };
  await assert.rejects(f.runtime.resume(slot, 'refresh', 'approved'), { code: 'CRON_OUTCOME_UNKNOWN' });
  assert.equal(f.control.paused, false, 'A contradictory reply must not hide a committed resume');
});

test('repeating a confirmed resume preserves the revision and existing alarm', async () => {
  const f = fixture(); f.control.paused = false; f.control.nextAlarm = 60000;
  const observed = await f.runtime.resume(slot, 'refresh', 'approved');
  assert.equal(observed.revision, 2);
  assert.equal(observed.nextAlarm, 60000);
});

test('cron snapshot confirms held approved replicas with stable observations and no control mutation', async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.snapshot(slot, 'refresh', 'approved'), f.control);
  assert.deepEqual(f.calls, ['info', 'a', 'b', 'info']);
});

test('cron snapshot refuses active, changing, stale or unreachable native state without control mutation', async () => {
  for (const change of [
    f => { f.control.paused = false; },
    f => { f.control.nextAlarm = 60000; },
    f => { f.states[1].version = 'old'; },
    f => { f.states[0].cells['.cron:refresh'] = 3; },
    f => { f.adapter.inspect = async () => { throw Error('private endpoint'); }; },
    f => { const inspect = f.adapter.inspect; f.adapter.inspect = async node => { f.control.revision++; return inspect(node); }; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.runtime.snapshot(slot, 'refresh', 'approved'), error => error.code === 'CRON_SNAPSHOT_UNCONFIRMED' && !error.message.includes('private'));
    assert.ok(!f.calls.includes('pause')); assert.ok(!f.calls.includes('resume'));
  }
});

test('repeated pause commands preserve the native control reply without extra mutations', async () => {
  const f = fixture();
  const first = await f.runtime.pause(slot, 'refresh');
  const repeated = await f.runtime.pause(slot, 'refresh');
  assert.equal(first.revision, 2); assert.deepEqual(repeated, first);
  assert.deepEqual(f.calls, ['pause', 'info', 'pause', 'info']);
});

test('missing or refused identity policy blocks every cron command before dispatch', async () => {
  for (const verify of [undefined, async () => { throw Error('private-credential'); }]) {
    for (const verb of ['status', 'pause', 'resume']) {
      const f = fixture(); f.adapter.verify = verify;
      await assert.rejects(f.runtime[verb](slot, 'refresh', 'approved'), error =>
        error.code === 'CRON_RUNTIME_UNVERIFIED' && !error.message.includes('private-credential') && !JSON.stringify(error).includes('private-credential'));
      assert.deepEqual(f.calls, []);
    }
  }
});

test('fresh identity verification precedes each command, including confirmation reads', async () => {
  const f = fixture(), run = f.adapter.run, ordering = [];
  f.adapter.verify = async selected => { assert.equal(selected, slot); ordering.push('identity'); };
  f.adapter.run = async (...args) => { ordering.push(args[1][1]); return run(...args); };
  await f.runtime.resume(slot, 'refresh', 'approved');
  assert.deepEqual(ordering, ['identity', 'info', 'identity', 'resume', 'identity', 'info']);
});

test('identity refusal before mutation remains a refusal; after dispatch it leaves outcome unknown', async () => {
  for (const boundary of ['before', 'after']) {
    const f = fixture(); let checked = 0;
    f.adapter.verify = async () => {
      if (++checked === (boundary === 'before' ? 2 : 3)) throw Error('runtime replaced');
    };
    await assert.rejects(f.runtime.resume(slot, 'refresh', 'approved'), {
      code: boundary === 'before' ? 'CRON_RUNTIME_UNVERIFIED' : 'CRON_OUTCOME_UNKNOWN',
    });
    assert.equal(f.control.paused, boundary === 'before');
    assert.equal(f.calls.filter(call => call === 'resume').length, boundary === 'before' ? 0 : 1);
  }
});

test('snapshot reports an unconfirmed observation when identity is refused without sending any command', async () => {
  const f = fixture(); delete f.adapter.verify;
  await assert.rejects(f.runtime.snapshot(slot, 'refresh', 'approved'), error =>
    error.code === 'CRON_SNAPSHOT_UNCONFIRMED' && error.cause.code === 'CRON_RUNTIME_UNVERIFIED');
  assert.deepEqual(f.calls, []);
});

test('bootstrap preflight is a separate callback and never falls back to ordinary verification', async () => {
  const f = fixture(); let ordinary = 0, bootstrap = 0;
  f.adapter.verify = async () => { ordinary++; };
  await assert.rejects(f.runtime.preflightBootstrap(slot), { code: 'CRON_RUNTIME_UNVERIFIED' });
  f.adapter.verifyBootstrap = async () => { bootstrap++; };
  await f.runtime.preflightBootstrap(slot);
  assert.equal(ordinary, 0); assert.equal(bootstrap, 1); assert.deepEqual(f.calls, []);
});

test('cron commands never use the bootstrap verifier', async () => {
  for (const verb of ['status', 'pause', 'resume']) {
    const f = fixture(); let bootstrap = 0; delete f.adapter.verify;
    f.adapter.verifyBootstrap = async () => { bootstrap++; };
    await assert.rejects(f.runtime[verb](slot, 'refresh', 'approved'), { code: 'CRON_RUNTIME_UNVERIFIED' });
    assert.equal(bootstrap, 0); assert.deepEqual(f.calls, []);
  }
});
