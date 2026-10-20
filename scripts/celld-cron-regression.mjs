// Execute the actual pinned cron class with modeled storage/event host primitives.
// The plan stub covers only the two every-minute expressions used by the native probe.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(process.argv[2], 'utf8');
const start = source.indexOf('class CelldCronSchedule {');
const end = source.indexOf('\nconst __cell = __celld.__cell', start);
assert.ok(start >= 0 && end > start, 'Expected pinned native cron class');
const controls = process.argv.includes('--controls');
const T = 1800000000000;
const expressions = ['* * * * *', '*/1 * * * *'];
function runtime({ held = false } = {}) {
  const world = { now: T, alarm: null, rows: new Map(), calls: [], failAlarm: false };
  if (controls && !held) world.rows.set('__cron_control_v1', {paused:false, revision:1});
  const alarm = value => { if (world.failAlarm) { world.failAlarm = false; throw Error('alarm write failed'); } world.alarm = value; };
  const storage = { _scope: '.cron:test',
    kv: { get: key => structuredClone(world.rows.get(key)), put: (key, value) => world.rows.set(key, structuredClone(value)) },
    getAlarm: async () => world.activeAlarm ? null : world.alarm, setAlarm: async value => alarm(value), deleteAlarm: async () => alarm(null),
    transactionSync(callback) { const rows = structuredClone(world.rows), before = world.alarm; try { return callback(); } catch (error) { world.rows = rows; world.alarm = before; throw error; } },
  };
  const cell = { script:'test', crons: [...expressions], env: {}, async selfScheduled(controller) {
    world.calls.push({ cron: controller.cron, scheduledTime: controller.scheduledTime });
    if (world.calls.length === 1) throw Error('first callback fails');
  } };
  const context = vm.createContext({ URL, Request, Date: class extends Date { static now() { return world.now; } }, Response,
    __cell: cell, console: { error() {} }, __beginEvent: () => ({}), __endEvent: () => { if (world.failDrain) { world.failDrain = false; return Promise.reject(Error("drain failed")); } return null; },
    __alarm_active: () => Boolean(world.activeAlarm),
    __alarm_set: (_scope, value) => alarm(value), __alarm_delete: () => alarm(null),
    __cron_plan(crons, fired, now, count, failed) {
      assert.ok(crons.every(value => expressions.includes(value)), 'Model supports only every-minute fixtures');
      const next = Math.floor(now / 60000 + 1) * 60000;
      const retry = failed && count < 6 ? now + 2000 * 2 ** count : Infinity;
      return { matching: fired < 0 ? [] : crons.map((_, index) => index), armAt: crons.length ? Math.min(next, retry) : null, armIsRetry: retry < next };
    },
  });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.Cron = CelldCronSchedule;', context);
  return { world, cell, create: () => new context.Cron({ storage }) };
}
async function failedOccurrence(r) {
  await r.create().alarm({ scheduledTime: T });
  assert.equal(r.world.alarm, T + 4000);
  assert.equal(r.world.calls.length, 2);
}
const cases = {
  async 'retry keeps original occurrence and only failed expression after reconstruction'() {
    const r = runtime(); await failedOccurrence(r); r.world.now = T + 4000;
    await r.create().alarm({ scheduledTime: r.world.alarm });
    assert.deepEqual(r.world.calls.slice(2), [{ cron: expressions[0], scheduledTime: T }]);
  },
  async 'cold arm preserves a future retry deadline'() {
    const r = runtime(); await failedOccurrence(r); r.world.now = T + 1000;
    await r.create().fetch(); assert.equal(r.world.alarm, T + 4000);
  },
  async 'declaration order cannot redirect a retry to its successful sibling'() {
    const r = runtime(); await failedOccurrence(r); r.cell.crons.reverse(); r.world.now = T + 4000;
    await r.create().alarm({ scheduledTime: r.world.alarm });
    assert.deepEqual(r.world.calls.slice(2), [{ cron: expressions[0], scheduledTime: T }]);
  },
  async 'removed expression does not retry another expression'() {
    const r = runtime(); await failedOccurrence(r); r.cell.crons = [expressions[1]]; r.world.now = T + 4000;
    await r.create().alarm({ scheduledTime: r.world.alarm }); assert.equal(r.world.calls.length, 2);
  },
  async 'alarm failure retains the original armed identity atomically'() {
    const r = runtime(), instance = r.create(); r.world.now = T - 1000;
    await instance.fetch(); const before = structuredClone(r.world.rows);
    r.world.now = T; r.world.failAlarm = true;
    await assert.rejects(instance.alarm({ scheduledTime: T }), /alarm write failed/);
    assert.equal(r.world.alarm, T); assert.deepEqual(r.world.rows, before);
    assert.equal(instance._retry, 0); assert.equal(instance._owed.at, T);
  },
  async 'runtime backoff after first occurrence drain failure keeps identity across minutes'() {
    const r = runtime(); r.world.now = T - 1000; await r.create().fetch();
    r.world.now = T; r.world.failDrain = true;
    await assert.rejects(r.create().alarm({ scheduledTime: T }), /drain failed/);
    r.world.alarm = T + 65000; r.world.now = T + 65000;
    await r.create().alarm({ scheduledTime: r.world.alarm, retryCount: 1 });
    assert.deepEqual(r.world.calls.slice(1), expressions.map(cron => ({ cron, scheduledTime: T })));
  },
  async 'failed retry transaction keeps identity for subsequent runtime backoff'() {
    const r = runtime(); await failedOccurrence(r); const before = structuredClone(r.world.rows);
    r.world.now = T + 4000; r.world.failAlarm = true;
    await assert.rejects(r.create().alarm({ scheduledTime: r.world.alarm }), /alarm write failed/);
    assert.deepEqual(r.world.rows, before);
    r.world.alarm = T + 65000; r.world.now = T + 65000;
    await r.create().alarm({ scheduledTime: r.world.alarm, retryCount: 1 });
    assert.deepEqual(r.world.calls.slice(2), [0, 1].map(() => ({ cron: expressions[0], scheduledTime: T })));
  },
  async 'cold arm preserves changed runtime-backoff deadline'() {
    const r = runtime(); r.world.now = T - 1000; await r.create().fetch();
    r.world.alarm = T + 65000; r.world.now = T + 60000;
    await r.create().fetch(); assert.equal(r.world.alarm, T + 65000);
  },
  async 'missing alarm with retained identity heals on reconstruction'() {
    const r = runtime(); await failedOccurrence(r); r.world.alarm = null; r.world.now = T + 5000;
    await r.create().fetch(); assert.equal(r.world.alarm, T + 60000);
  },
  async 'arm request during active handler cannot overwrite its hidden alarm'() {
    const r = runtime(), instance = r.create(); r.world.now = T - 1000; await instance.fetch();
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    r.cell.selfScheduled = async controller => { r.world.calls.push(controller.cron); enter(); await held; };
    r.world.now = T; r.world.activeAlarm = true;
    const running = instance.alarm({ scheduledTime: T }); await entered;
    const before = structuredClone(r.world.rows); await instance.fetch();
    assert.deepEqual(r.world.rows, before); assert.equal(r.world.alarm, T);
    release(); await running; r.world.activeAlarm = false;
    assert.equal(r.world.alarm, T + 60000);
  },
  async 'host settlement releases arming without a JavaScript finally block'() {
    const r = runtime(), instance = r.create(); r.world.now = T - 1000;
    await instance.fetch(); const before = structuredClone(r.world.rows);
    // Native begin_alarm_handler precedes entry into JS and hides the row.
    r.world.activeAlarm = true; r.world.alarm = null;
    await instance.fetch(); assert.deepEqual(r.world.rows, before);
    assert.equal(r.world.alarm, null);
    // Native settlement clears the guard even if execution never resumes in JS.
    r.world.activeAlarm = false; r.world.now = T + 5000;
    await instance.fetch(); assert.equal(r.world.alarm, T + 60000);
  },
  async 'legacy runtime backoff without identity cannot guess an earlier minute'() {
    const r = runtime(); r.world.alarm = T + 65000; r.world.now = T + 65000;
    await r.create().alarm({ scheduledTime: r.world.alarm, retryCount: 1 });
    assert.equal(r.world.calls.length, 0); assert.equal(r.world.alarm, T + 120000);
  },
  async 'legacy retry without identity cannot invent an occurrence'() {
    const r = runtime(); r.world.alarm = T + 4000; r.world.now = T + 4000;
    await r.create().alarm({ scheduledTime: r.world.alarm });
    assert.equal(r.world.calls.length, 0); assert.equal(r.world.alarm, T + 60000);
  },
  async 'uncounted native retries stop replaying an occurrence at the bound'() {
    const r = runtime(); await failedOccurrence(r); r.world.now = T + 4000;
    await r.create().alarm({ scheduledTime: r.world.alarm, retryCount: 6 });
    assert.equal(r.world.calls.length, 2);
    assert.equal(r.world.alarm, T + 60000);
    assert.equal(r.world.rows.get('__cron_retry_v1').owed.at, T + 60000);
  },
  async 'next occurrence supersedes a later retry'() {
    const r = runtime(); r.world.now = T + 59000;
    await r.create().alarm({ scheduledTime: T }); assert.equal(r.world.alarm, T + 60000);
    r.world.now = T + 60000; await r.create().alarm({ scheduledTime: r.world.alarm });
    assert.deepEqual(r.world.calls.slice(2), expressions.map(cron => ({ cron, scheduledTime: T + 60000 })));
  },
};
async function command(instance, op) {
  const response = await instance.fetch(new Request('http://cell/', {method:'POST', body:JSON.stringify({op})}));
  assert.equal(response.status, 200);
  const reply = await response.json();
  assert.ok(reply?.result && typeof reply.result === 'object', 'Authenticated operator transport requires a result envelope');
  return reply.result;
}
const controlCases = {
  async 'failed resume leaves the hold and alarm unchanged'() {
    const r = runtime({held:true}); r.world.failAlarm = true;
    await assert.rejects(command(r.create(), 'resume'), /alarm write failed/);
    assert.equal((await command(r.create(), 'info')).paused, true);
    assert.equal(r.world.alarm, null);
  },
  async 'a control cannot materialize another script schedule'() {
    const r = runtime(); r.cell.script = 'other';
    assert.throws(() => r.create(), /cron scope does not match/);
  },
  async 'malformed persisted controls fail closed'() {
    const r = runtime(); r.world.rows.set('__cron_control_v1', {});
    await assert.rejects(r.create().alarm({scheduledTime:T}), /invalid persisted cron control/);
    assert.equal(r.world.calls.length, 0);
  },
  async 'missing control record holds a restored due alarm and bootstrap'() {
    const r = runtime({held:true}); r.world.alarm = T;
    await r.create().alarm({scheduledTime:T}); await r.create().fetch();
    assert.equal(r.world.calls.length, 0);
    assert.equal((await command(r.create(), 'info')).paused, true);
  },
  async 'resume skips held history and persists across reconstruction'() {
    const r = runtime({held:true}); r.world.now = T + 65000;
    const status = await command(r.create(), 'resume');
    assert.equal(status.paused, false); assert.equal(r.world.alarm, T + 120000);
    await r.create().fetch(); assert.equal(r.world.alarm, T + 120000);
    // Repeating a lost response must not change the already armed occurrence.
    r.world.now = T + 125000; await command(r.create(), 'resume');
    assert.equal(r.world.alarm, T + 120000);
  },
  async 'pause persists and deletes a pending retry'() {
    const r = runtime(); await failedOccurrence(r);
    await command(r.create(), 'pause');
    assert.equal(r.world.alarm, null);
    assert.equal(r.world.rows.get('__cron_retry_v1').owed, null);
    await r.create().alarm({scheduledTime:T + 4000, retryCount:1});
    assert.equal(r.world.calls.length, 2);
    assert.equal((await command(r.create(), 'info')).paused, true);
  },
  async 'pause and resume cannot let an old callback dispatch siblings or rearm'() {
    const r = runtime(), instance = r.create(); r.world.now = T - 1000; await instance.fetch();
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    r.cell.selfScheduled = async controller => { r.world.calls.push(controller.cron); enter(); await held; };
    r.world.now = T;
    const running = instance.alarm({scheduledTime:T}); await entered;
    await command(r.create(), 'pause');
    r.world.now = T + 65000; await command(r.create(), 'resume');
    release(); await running;
    assert.equal(r.world.calls.length, 1); assert.equal(r.world.alarm, T + 120000);
  },
  async 'failed pause transaction leaves the running schedule intact'() {
    const r = runtime(); await failedOccurrence(r); const before = structuredClone(r.world.rows);
    r.world.failAlarm = true;
    await assert.rejects(command(r.create(), 'pause'), /alarm write failed/);
    assert.deepEqual(r.world.rows, before); assert.equal(r.world.alarm, T + 4000);
  },
};
if (controls) Object.assign(cases, controlCases);
for (const [name, check] of Object.entries(cases)) { await check(); console.log(`PASS: ${name}`); }
