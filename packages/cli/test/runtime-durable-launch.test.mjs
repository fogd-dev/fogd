import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDurableInstallation } from '../src/runtime/durable-launch.mjs';
import { acquireLaunchFence } from '../src/runtime/launch-fence.mjs';
import { freshRuntimePlan } from '../src/runtime/selection-plan.mjs';
import { durablePlanSha256 } from '../src/runtime/durable-config.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { beginDurableEnrollment } from '../src/runtime/enrollment-record.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const enrolled = ['enrollment.complete.json', 'enrollment.pending.json'];
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fogd-durable-launch-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const { source, profile } = prebootFixture();
  Object.assign(source.services.controller.environment, { FOGD_ADMIN_USER: 'admin', FOGD_ADMIN_PASSWORD: 'synthetic-admin', FOGD_GATEWAY_TOKEN: 'synthetic-gateway' });
  source.services.controller.ports = [{ target: 8082, published: '18788', host_ip: '127.0.0.1', protocol: 'tcp' }];
  const entry = { ...profile, schema: 2, id: 'durable-candidate', routing: 'durable', admission: 'candidate' };
  const plan = freshRuntimePlan(source, entry), selected = { ...plan, entry };
  const enrollment = await beginDurableEnrollment(directory, { project: plan.config.name, installation: runtimePolicyIdentity(plan.policy), planSha256: durablePlanSha256(plan.config, plan.policy) });
  await enrollment.complete(hash('inventory'));
  const states = Object.fromEntries(Object.keys(plan.config.services).map(name => [name,
    { id: hash(name), running: false, restarting: false, paused: false, status: name === 'bucket-init' ? 'exited' : 'created', exitCode: 0, startedAt: '' }]));
  const authority = { record: { schema: 1, installation: hash('installation'), revision: '0', routes: [] }, sha256: hash('authority') };
  const calls = [], marker = () => readFile(join(directory, 'launch.pending.json'), 'utf8').then(JSON.parse);
  const options = { directory, server: undefined, ready: async () => {}, recovery: async () => {}, authorize: async () => entry,
    verify: async () => {}, readPolicy: async () => plan.policy, delay: async () => {},
    inspect: async () => ({ identity: hash('inventory'), services: structuredClone(states) }),
    readStores: async () => ({ authority: structuredClone(authority), gatewayPolicy: {} }),
    observe: async env => { calls.push(['preflight', env.FOGD_SERVER, (await marker()).phase]); assert.equal(states.workerd.running, false); return { authority: structuredClone(authority) }; },
    run: async args => {
      calls.push([...args]);
      assert.ok(['starting', 'preflight', 'ingress'].includes((await marker()).phase));
      const ids = args.slice(1).filter(hashValue => /^[a-f0-9]{64}$/.test(hashValue));
      for (const state of Object.values(states).filter(state => ids.includes(state.id))) {
        state.running = args[0] === 'start'; state.status = state.running ? 'running' : 'exited'; state.startedAt = '2026-10-23T00:00:00Z';
      }
    } };
  return { selected, options, states, calls, marker, directory, authority };
}
test('retained startup verifies before effects and opens only the inspected gateway last', async t => {
  const f = await fixture(t), result = await startDurableInstallation(f.selected, f.options);
  assert.equal(result.status, 'started'); assert.equal(result.project, 'original'); assert.equal(result.authoritySha256, f.authority.sha256);
  assert.deepEqual(f.calls, [['start', hash('minio')], ['start', hash('slot-1-a'), hash('slot-1-b'), hash('slot-2-a'), hash('slot-2-b')],
    ['start', hash('controller')], ['preflight', 'http://127.0.0.1:18788', 'preflight'], ['start', hash('workerd')]]);
  assert.deepEqual((await readdir(f.directory)).sort(), enrolled); assert.equal(f.states.workerd.running, true);
});
test('an uncompleted bucket initializer is attached and must finish before backend startup', async t => {
  const f = await fixture(t); f.states['bucket-init'].status = 'created';
  const run = f.options.run;
  f.options.run = async args => { await run(args); if (args.includes('--attach')) { f.states['bucket-init'].running = false; f.states['bucket-init'].status = 'exited'; } };
  await startDurableInstallation(f.selected, f.options);
  assert.deepEqual(f.calls[1], ['start', '--attach', hash('bucket-init')]);
});
test('read-only verification failure releases checking fence without Docker mutation or private diagnostics', async t => {
  const f = await fixture(t); f.options.verify = async () => { throw new Error('PRIVATE verification failure'); };
  await assert.rejects(startDurableInstallation(f.selected, f.options), error => error.code === 'ROUTE_STARTUP_UNCONFIRMED' && !error.message.includes('PRIVATE') && !('cause' in error));
  assert.deepEqual(f.calls, []); assert.deepEqual((await readdir(f.directory)).sort(), enrolled);
});
test('a foreign installed policy refuses before starting any container', async t => {
  const f = await fixture(t); f.options.readPolicy = async () => ({ ...f.selected.policy, binarySha256: hash('foreign') });
  await assert.rejects(startDurableInstallation(f.selected, f.options), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.deepEqual(f.calls, []); assert.deepEqual((await readdir(f.directory)).sort(), enrolled);
});
test('an initially running gateway refuses without stopping a pre-existing live installation', async t => {
  const f = await fixture(t); Object.assign(f.states.workerd, { running: true, status: 'running' });
  await assert.rejects(startDurableInstallation(f.selected, f.options), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.deepEqual(f.calls, []); assert.equal(f.states.workerd.running, true); assert.deepEqual((await readdir(f.directory)).sort(), enrolled);
});
test('startup waits for an available controller using fresh observations while ingress remains stopped', async t => {
  const f = await fixture(t), observe = f.options.observe; let tries = 0, delays = 0;
  f.options.observe = async (...args) => { if (++tries === 1) throw new Error('not ready'); return observe(...args); };
  f.options.delay = async () => { delays++; };
  await startDurableInstallation(f.selected, f.options);
  assert.equal(tries, 2); assert.equal(delays, 1);
});
test('changed authority after preflight never starts ingress and preserves the started fence', async t => {
  const f = await fixture(t); let reads = 0;
  f.options.readStores = async () => ({ authority: ++reads === 1 ? f.authority : { ...f.authority, sha256: hash('changed') } });
  await assert.rejects(startDurableInstallation(f.selected, f.options), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.equal(f.calls.some(args => args[0] === 'start' && args.includes(hash('workerd'))), false);
  assert.equal((await f.marker()).phase, 'preflight');
  await assert.rejects(startDurableInstallation(f.selected, f.options), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
});
test('replaced inventory after preflight refuses before gateway start', async t => {
  const f = await fixture(t), observe = f.options.observe; let replaced = false;
  f.options.observe = async (...args) => { const report = await observe(...args); replaced = true; return report; };
  f.options.inspect = async () => ({ identity: hash(replaced ? 'replaced' : 'inventory'), services: structuredClone(f.states) });
  await assert.rejects(startDurableInstallation(f.selected, f.options), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.equal(f.calls.some(args => args[0] === 'start' && args.includes(hash('workerd'))), false); assert.equal((await f.marker()).phase, 'preflight');
});
test('container restart after preflight cannot reuse its prior readiness observation', async t => {
  const f = await fixture(t), observe = f.options.observe;
  f.options.observe = async (...args) => { const report = await observe(...args); f.states['slot-1-a'].startedAt = '2026-10-23T00:00:01Z'; return report; };
  await assert.rejects(startDurableInstallation(f.selected, f.options), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.equal(f.calls.some(args => args[0] === 'start' && args.includes(hash('workerd'))), false);
  assert.equal((await f.marker()).phase, 'preflight');
});
test('lost gateway start acknowledgment attempts a stop and retains the ingress fence', async t => {
  const f = await fixture(t), run = f.options.run;
  f.options.run = async args => { await run(args); if (args[0] === 'start' && args.includes(hash('workerd'))) throw new Error('lost acknowledgment'); };
  await assert.rejects(startDurableInstallation(f.selected, f.options), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.deepEqual(f.calls.at(-1), ['stop', '--time', '30', hash('workerd')]); assert.equal(f.states.workerd.running, false);
  assert.equal((await f.marker()).phase, 'ingress');
});
test('uncertain fence release after completed startup never races a successor by stopping verified ingress', async t => {
  const f = await fixture(t);
  f.options.acquire = async (...args) => { const fence = await acquireLaunchFence(...args); return { ...fence, release: async () => { throw new Error('sync uncertainty'); } }; };
  await assert.rejects(startDurableInstallation(f.selected, f.options), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.equal(f.states.workerd.running, true); assert.equal((await f.marker()).phase, 'complete');
  assert.equal(f.calls.some(args => args[0] === 'stop'), false);
});
test('controller preflight deadline preserves the started fence and never opens ingress', { timeout: 15000 }, async t => {
  const f = await fixture(t), observing = Promise.withResolvers();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.options.observe = async (_env, _profile, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('unavailable')), { once: true }); observing.resolve();
  });
  const running = startDurableInstallation(f.selected, f.options);
  await observing.promise; t.mock.timers.tick(90000);
  await assert.rejects(running, { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.equal(f.calls.some(args => args[0] === 'start' && args.includes(hash('workerd'))), false);
  assert.equal((await f.marker()).phase, 'preflight');
});
test('a cleartext remote admin endpoint refuses before any Docker mutation', async t => {
  const f = await fixture(t); f.options.server = 'http://remote.example:18788';
  await assert.rejects(startDurableInstallation(f.selected, f.options), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.deepEqual(f.calls, []); assert.deepEqual((await readdir(f.directory)).sort(), enrolled);
});
test('a report delivered after deadline cancellation cannot open ingress', { timeout: 15000 }, async t => {
  const f = await fixture(t), observing = Promise.withResolvers();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.options.observe = async (_env, _profile, { signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ authority: f.authority }), { once: true }); observing.resolve();
  });
  const running = startDurableInstallation(f.selected, f.options);
  await observing.promise; t.mock.timers.tick(90000);
  await assert.rejects(running, { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.equal(f.calls.some(args => args[0] === 'start' && args.includes(hash('workerd'))), false);
  assert.equal((await f.marker()).phase, 'preflight');
});
test('durable startup cannot bypass a missing host enrollment record', async t => {
  const f = await fixture(t); await rm(join(f.directory, 'enrollment.pending.json')); await rm(join(f.directory, 'enrollment.complete.json'));
  await assert.rejects(startDurableInstallation(f.selected, f.options), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(f.directory), []);
});
test('durable startup preserves and refuses an incomplete host enrollment', async t => {
  const f = await fixture(t); await rm(join(f.directory, 'enrollment.complete.json'));
  await assert.rejects(startDurableInstallation(f.selected, f.options), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(f.directory), ['enrollment.pending.json']);
});
test('a completed enrollment cannot authorize a changed retained plan', async t => {
  const f = await fixture(t); f.selected.config.services.controller.environment.FOGD_MAX_PENDING = '23';
  await assert.rejects(startDurableInstallation(f.selected, f.options), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.deepEqual(f.calls, []); assert.deepEqual((await readdir(f.directory)).sort(), enrolled);
});

test('a consistently replaced resource inventory cannot reuse completed enrollment', async t => {
  const f = await fixture(t), inspect = f.options.inspect;
  f.options.inspect = async (...args) => ({ ...await inspect(...args), identity: hash('replacement inventory') });
  await assert.rejects(startDurableInstallation(f.selected, f.options), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.deepEqual(f.calls, []); assert.deepEqual((await readdir(f.directory)).sort(), enrolled);
  assert.equal(f.states.workerd.running, false);
});
