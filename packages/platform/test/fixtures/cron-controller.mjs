import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { artifactDigest } from '@fogd/runtime/artifact';
import { Controller } from '../../src/controller.mjs';
import { requireCronCapability } from '../../src/cron-dispatch.mjs';
import { readJson, saveJson } from '../../src/store.mjs';
import { cronBackend } from './cron-backend.mjs';

export const slots = [{ id: 'one', prefix: 'one', nodes: ['a', 'b'] }];
export async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-cron-activation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let failure, beforeFailure, writeFailure;
  const backend = cronBackend(dir, event => { if (failure === event) { failure = null; throw Error(`Lost ${event} response`); } },
    event => { if (beforeFailure === event) { beforeFailure = null; throw Error(`Unreachable ${event}`); } });
  const persist = async (path, value) => {
    const fail = writeFailure?.(value);
    if (fail === 'before') throw Error('disk unavailable');
    await saveJson(path, value);
    if (fail === 'after') throw Error('lost write response');
  };
  const create = () => new Controller({ dir, slots, backend, persist, reportStorageFailure: () => {} });
  const c = create(); await c.init();
  // Private staging bypasses artifact admission. Ordinary triggers stay rejected.
  async function request(controller = c, { crons = ['* * * * *'], requiredSecrets = [] } = {}) {
    const id = randomUUID(), artifact = controller.artifact(id);
    await mkdir(join(artifact, 'worker'), { recursive: true });
    await mkdir(join(artifact, 'migrations/DB'), { recursive: true });
    const sql = 'CREATE TABLE refreshes (id TEXT PRIMARY KEY);';
    await writeFile(join(artifact, 'migrations/DB/0001_refresh.sql'), sql);
    await writeFile(join(artifact, 'worker/index.js'), `// ${id}\nexport default {scheduled(){}};`);
    const d1 = [{ binding: 'DB', database_name: 'refresh-db', database_id: 'refresh-db', migrations_dir: 'migrations/DB' }];
    await writeFile(join(artifact, 'wrangler.json'), JSON.stringify({ name: 'refresh', main: 'worker/index.js', triggers: { crons }, d1_databases: d1 }));
    const migrations = [{ database: 'refresh-db', name: '0001_refresh.sql', digest: createHash('sha256').update(sql).digest('hex') }];
    const value = { id, app: 'refresh', digest: await artifactDigest(artifact), resources: { script: 'refresh', crons, d1, r2: [], durable: { bindings: [] } }, migrations, requiredSecrets, status: 'pending', step: 'submitted' };
    requireCronCapability(controller.state, value.resources);
    controller.state.deployments[id] = value; await controller.save(); return value;
  }
  return { c, dir, backend, create, request, runtime: () => readJson(join(dir, 'cron-runtime.json'), { events: [], paused: true }),
    fail: (event, when = 'after') => { if (when === 'before') beforeFailure = event; else failure = event; }, failWrite: callback => { writeFailure = callback; } };
}
