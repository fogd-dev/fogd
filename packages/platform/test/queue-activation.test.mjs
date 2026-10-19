import { requireQueueCapability } from '../src/queue-activation.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueBackend } from './fixtures/queue-backend.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { artifactDigest } from '@fogd/runtime/artifact';
import { Controller } from '../src/controller.mjs';
import { Backend } from '../src/backend.mjs';
import { readJson, saveJson } from '../src/store.mjs';
import { resourceChanges } from '../src/resources.mjs';

const slots = [{ id: 'one', prefix: 'one', nodes: ['a', 'b'] }];
const queues = { producers: [{ binding: 'QUEUE', queue: 'jobs' }], consumers: [{ queue: 'jobs', max_retries: 1 }] };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-queue-activation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const events = []; let owner = null, version = null, paused = false, failure = null;
  const effect = name => { events.push(name); if (failure === name) { failure = null; throw Error(`Lost ${name} response`); } };
  const backend = {
    owner: async () => owner,
    hasDeployment: async () => Boolean(version),
    claim: async (_, app) => { owner = { app }; },
    bootstrap: async () => { version = 'bootstrap'; effect('bootstrap'); return version; },
    ready: async (_, expected) => { assert.equal(version, expected); effect('ready'); },
    publish: async () => { assert.equal(paused, true); version = 'application'; effect('publish'); return version; },
    migrate: async () => { assert.equal(paused, true); effect('migrate'); },
    applied: async () => { assert.equal(paused, true); effect('ledger'); return []; },
    queues: {
      pause: async () => { assert.ok(version); paused = true; effect('pause'); return { paused }; },
      resume: async (_, queue, expected) => { assert.equal(queue, 'jobs'); assert.equal(version, expected); paused = false; effect('resume'); return { paused }; },
    },
  };
  let writeFailure = null;
  const persist = async (path, value) => {
    const fail = writeFailure?.(value);
    if (fail === 'before') throw Error('disk unavailable');
    await saveJson(path, value);
    if (fail === 'after') throw Error('lost write response');
  };
  const create = () => new Controller({ dir, slots, backend, persist, reportStorageFailure: () => {} });
  const c = create(); await c.init();
  // Private fixture: queue artifact admission intentionally remains closed.
  async function request(controller = c) {
    const id = randomUUID(), artifact = controller.artifact(id);
    await mkdir(join(artifact, 'worker'), { recursive: true });
    await writeFile(join(artifact, 'worker/index.js'), 'export default {}');
    const config = { name: 'imports', main: 'worker/index.js', queues, d1_databases: [] };
    await writeFile(join(artifact, 'wrangler.json'), JSON.stringify(config));
    const value = { id, app: 'imports', digest: await artifactDigest(artifact), resources: { script: 'imports', d1: [], r2: [], durable: { bindings: [] }, queues }, migrations: [], requiredSecrets: [], status: 'pending', step: 'submitted' };
    requireQueueCapability(controller.state, value.resources);
    controller.state.deployments[id] = value; await controller.save(); return value;
  }
  return { c, create, request, events, backend, paused: () => paused,
    fail: name => { failure = name; }, failWrite: callback => { writeFailure = callback; } };
}
const approve = (c, r) => c.mutate(r.id, r.digest, 'approve');

test('queue activation bootstraps, pauses, migrates, publishes, checks readiness, then resumes', async t => {
  const f = await fixture(t), r = await f.request();
  assert.deepEqual(f.events, []);
  await approve(f.c, r);
  assert.equal(r.status, 'active');
  assert.deepEqual(f.events, ['bootstrap', 'ready', 'pause', 'ledger', 'migrate', 'ledger', 'publish', 'ready', 'resume']);
  assert.equal(f.c.state.apps.imports.delivery.hold, null);
  const next = await f.request(); f.events.length = 0;
  await approve(f.c, next);
  assert.deepEqual(f.events, ['pause', 'ledger', 'migrate', 'ledger', 'publish', 'ready', 'resume']);
});

test('operator pause survives an approved queue update', async t => {
  const f = await fixture(t), r = await f.request(); await approve(f.c, r);
  f.c.state.apps.imports.delivery.desired = 'paused'; await f.c.save();
  const next = await f.request(); f.events.length = 0; await approve(f.c, next);
  assert.equal(next.status, 'active'); assert.equal(f.paused(), true);
  assert.equal(f.events.at(-1), 'pause'); assert.equal(f.events.includes('resume'), false);
});

test('lost backend responses retain the hold and retry never overwrites consumer code with bootstrap', async t => {
  for (const failure of ['bootstrap', 'ready', 'pause', 'ledger', 'migrate', 'publish', 'resume']) {
    await t.test(failure, async t => {
      const f = await fixture(t), r = await f.request(); f.fail(failure);
      await approve(f.c, r); assert.equal(r.status, 'failed');
      assert.equal(f.c.state.apps.imports.delivery.hold, r.id);
      if (failure === 'resume') assert.equal(f.paused(), false, 'uncertain resume can really be running');
      await assert.rejects(f.c.mutate(r.id, r.digest, 'reject'), /held queue activation/);
      const other = await f.request(); await assert.rejects(approve(f.c, other), /held queue activation/);
      await f.c.mutate(other.id, other.digest, 'reject'); assert.equal(other.status, 'rejected');
      const before = f.events.length, restarted = f.create(); await restarted.init();
      assert.equal(f.events.slice(before).includes('resume'), false);
      await approve(restarted, restarted.state.deployments[r.id]);
      assert.equal(restarted.state.deployments[r.id].status, 'active');
      if (['publish', 'resume'].includes(failure)) assert.equal(f.events.slice(before).includes('bootstrap'), false);
    });
  }
});

test('ambiguous metadata writes at each queue activation boundary stop effects and recover on reload', async t => {
  const boundaries = [
    ['queue-bootstrap-intent', () => true],
    ['publishing-queue-bootstrap', () => true],
    ['waiting-for-queue-bootstrap', () => true],
    ['pausing-delivery', app => app.delivery.operation === 'pause'],
    ['checking-migration-ledger', () => true],
    ['migrating', () => true],
    ['queue-application-intent', () => true],
    ['waiting-for-replicas', () => true],
    ['releasing-delivery', app => app.delivery.operation === 'resume'],
    ['releasing-delivery', app => app.delivery.hold === null],
    ['complete', () => true],
  ];
  for (const [step, condition] of boundaries) for (const side of ['before', 'after']) {
    await t.test(`${step} ${side}`, async t => {
      const f = await fixture(t), r = await f.request();
      f.failWrite(state => state.deployments?.[r.id]?.step === step && condition(state.apps.imports) ? side : null);
      await assert.rejects(approve(f.c, r), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
      const count = f.events.length;
      await assert.rejects(approve(f.c, r), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
      assert.equal(f.events.length, count);
      f.failWrite(null); const restarted = f.create(); await restarted.init();
      const restored = restarted.state.deployments[r.id];
      if (restored.status === 'active') {
        assert.equal(step, 'complete'); assert.equal(side, 'after');
      } else {
        assert.equal(restored.status, 'failed');
        const app = restarted.state.apps.imports;
        if (app.delivery) assert.equal(app.delivery.hold, r.id);
        if (app.queueBootstrap && app.queueBootstrap.phase !== 'pending') assert.equal(f.paused(), true);
        await approve(restarted, restored); assert.equal(restored.status, 'active');
      }
      if (f.events.slice(0, count).includes('publish')) assert.equal(f.events.slice(count).includes('bootstrap'), false);
    });
  }
});

test('producer-only bootstrap excludes app code, consumer, secrets, and arbitrary bindings', async t => {
  const f = await fixture(t), r = await f.request();
  const backend = Object.create(Backend.prototype);
  backend.publish = async (_, dir) => {
    const config = JSON.parse(await readFile(join(dir, 'wrangler.json'), 'utf8'));
    assert.deepEqual(config, { name: 'imports', main: 'index.js', no_bundle: true, d1_databases: [], queues: { producers: queues.producers } });
    assert.match(await readFile(join(dir, 'index.js'), 'utf8'), /status:503/);
    return 'bootstrap';
  };
  assert.equal(await backend.bootstrap(slots[0], f.c.artifact(r.id), r.resources), 'bootstrap');
});

test('queue declaration changes cannot remove or silently change activation policy', () => {
  const current = { script: 'imports', d1: [], durable: {}, r2: [], queues };
  assert.doesNotThrow(() => resourceChanges(current, structuredClone(current)));
  assert.throws(() => resourceChanges(current, { ...current, queues: undefined }), /queues/);
  assert.throws(() => resourceChanges(current, { ...current, queues: { ...queues, consumers: [{ queue: 'different' }] } }), /queues/);
});


test('controller SIGKILL preserves activation holds for first deployment and updates', async t => {
  for (const update of [false, true]) for (const point of ['effect:bootstrap', 'effect:pause', 'effect:migrate', 'application-intent', 'effect:publish', 'effect:resume', 'released']) {
    if (update && point === 'effect:bootstrap') continue;
    await t.test(`${update ? 'update' : 'initial'} ${point}`, async t => {
      const f = await fixture(t), backend = queueBackend(f.c.dir);
      f.c.backend = backend;
      if (update) await approve(f.c, await f.request());
      const r = await f.request();
      const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/queue-activation-crash.mjs', import.meta.url)), f.c.dir, r.id, point], { encoding: 'utf8', timeout: 15000 });
      assert.equal(child.signal, 'SIGKILL', child.stderr);
      const runtimePath = join(f.c.dir, 'queue-runtime.json');
      const before = await readJson(runtimePath);
      const c = new Controller({ dir: f.c.dir, slots, backend }); await c.init();
      const after = await readJson(runtimePath);
      assert.equal(c.state.deployments[r.id].status, 'failed');
      assert.equal(c.route('imports.localhost').state, 'paused');
      assert.equal(c.state.apps.imports.delivery.hold, r.id);
      assert.equal(after.events.slice(before.events.length).includes('resume'), false);
      if (c.state.apps.imports.queueBootstrap.phase !== 'pending') assert.equal(after.paused, true);
      await approve(c, c.state.deployments[r.id]);
      assert.equal(c.state.deployments[r.id].status, 'active');
      if (before.events.includes('publish')) assert.equal((await readJson(runtimePath)).events.slice(before.events.length).includes('bootstrap'), false);
    });
  }
});


test('startup refuses queue declarations without the capability marker, before any runtime effect', async t => {
  const f = await fixture(t); await f.request();
  delete f.c.state.requirements; await f.c.save();
  await assert.rejects(f.create().init(), /Queue declarations require/);
  assert.deepEqual(f.events, []);
});

test('failed startup pause retains intent and never resumes or migrates', async t => {
  const f = await fixture(t), r = await f.request();
  f.fail('resume'); await approve(f.c, r);
  const count = f.events.length; f.fail('pause');
  const unavailable = f.create(); await unavailable.init();
  assert.match(unavailable.state.apps.imports.deliveryRecoveryError, /could not be confirmed/);
  assert.deepEqual(f.events.slice(count), ['pause']);
  const state = await readJson(join(f.c.dir, 'state.json'));
  assert.equal(state.apps.imports.delivery.hold, r.id);
  assert.equal(state.apps.imports.delivery.operation, 'pause');
  const restarted = f.create(); await restarted.init();
  assert.equal(f.paused(), true);
  assert.equal(restarted.state.deployments[r.id].status, 'failed');
  await approve(restarted, restarted.state.deployments[r.id]);
  assert.equal(restarted.state.apps.imports.deliveryRecoveryError, undefined);
});

test('an older controller snapshot cannot bootstrap over an existing deployment', async t => {
  const f = await fixture(t), r = await f.request();
  await approve(f.c, r);
  const app = f.c.state.apps.imports;
  delete app.delivery; delete app.queueBootstrap; app.active = null;
  r.status = 'failed'; await f.c.save();
  const count = f.events.length;
  await approve(f.c, r);
  assert.equal(r.status, 'failed'); assert.match(r.error, /unpublished fleet/);
  assert.deepEqual(f.events.slice(count), []);
});

test('invalid hold ownership is diagnosed before runtime commands', async t => {
  const f = await fixture(t), r = await f.request(); f.fail('publish'); await approve(f.c, r);
  f.c.state.apps.imports.delivery.hold = randomUUID(); await f.c.save();
  const count = f.events.length;
  await assert.rejects(f.create().init(), /hold owner/);
  assert.equal(f.events.length, count);
});

test('unavailable queue recovery leaves another app routable and does not retire the queued app', async t => {
  const { retirementApp } = await import('../src/retirement.mjs');
  const f = await fixture(t), r = await f.request(); await approve(f.c, r);
  assert.throws(() => retirementApp(f.c.state, 'imports', r.digest), /retirement is not qualified/);
  const next = await f.request(); f.fail('resume'); await approve(f.c, next);
  f.c.state.apps.other = { slot: 'two', active: 'other', route: 'active', resources: { script: 'other', d1: [], r2: [], durable: {} }, migrations: [] };
  await f.c.save(); f.fail('pause');
  const backend = { ...f.backend, owner: slot => slot.id === 'two' ? Promise.resolve({ app: 'other' }) : f.backend.owner(slot) };
  const c = new Controller({ dir: f.c.dir, slots: [...slots, { id: 'two', prefix: 'two', nodes: ['c', 'd'] }], backend });
  await c.init();
  assert.equal(c.route('other.localhost').state, 'active');
  assert.equal(c.route('imports.localhost').state, 'paused');
  assert.equal(c.state.apps.imports.delivery.observed, 'unknown');
});
