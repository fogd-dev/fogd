import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { artifactDigest } from '@fogd/runtime/artifact';
import { Controller } from '../../src/controller.mjs';
import { requireQueueCapability } from '../../src/queue-activation.mjs';
import { saveJson } from '../../src/store.mjs';

export const slots = [{ id: 'one', prefix: 'one', nodes: ['a', 'b'] }];
export const queues = { producers: [{ binding: 'QUEUE', queue: 'jobs' }], consumers: [{ queue: 'jobs', max_batch_size: 1, max_batch_timeout: 1, max_retries: 1, retry_delay: 1 }] };

export async function fixture(t) {
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
  const create = () => new Controller({ queueApps: true, dir, slots, backend, persist, reportStorageFailure: () => {} });
  const c = create(); await c.init();
  // Private fixture bypasses artifact validation; admission defaults off elsewhere.
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
