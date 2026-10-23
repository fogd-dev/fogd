import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { artifactDigest } from '@fogd/runtime/artifact';
import { Controller } from '../../src/controller.mjs';
import { saveJson } from '../../src/store.mjs';
import { writeRouteRecord } from '../../src/route-record-store.mjs';

export async function routeController(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-route-controller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'private'), authority = join(root, 'authority'); await mkdir(authority, { mode: 0o755 });
  const path = join(authority, 'routes.json'), statePath = join(dir, 'state.json');
  const slots = [{ id: 'slot-1', prefix: 'first', nodes: ['a', 'b'] }, { id: 'slot-2', prefix: 'second', nodes: ['c', 'd'] }];
  const policy = { installation: 'a'.repeat(64), slots: slots.map(slot => slot.id) };
  const owners = {}, versions = {}, events = []; let fault = null, publicFault = null, privateFault = null;
  const publicRecord = async () => JSON.parse(await readFile(path, 'utf8'));
  async function effect(kind, slot) {
    const record = await publicRecord(), target = record.routes.find(value => value.slot === slot.id);
    assert.equal(target?.state, 'withheld', `${kind} must follow durable HTTP withholding`);
    const saved = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(saved.routeAuthority.pending, null);
    assert.ok(saved.routeAuthority.holds[target.host.split('.')[0]]);
    events.push({ kind, slot: slot.id, revision: record.revision });
    if (fault === kind) { fault = null; throw new Error(`Failed ${kind}`); }
  }
  const backend = {
    owner: async slot => owners[slot.id] || null,
    hasDeployment: async slot => Boolean(versions[slot.id]),
    assertUnclaimed: async slot => { if (owners[slot.id] || versions[slot.id]) throw new Error('Not pristine'); },
    async claim(slot, app) { await effect('claim', slot); owners[slot.id] = { app }; },
    async publish(slot) { await effect('publish', slot); return versions[slot.id] = randomUUID(); },
    ready: async slot => effect('ready', slot),
    applicationReady: async slot => effect('application-ready', slot),
    migrate: async slot => effect('migrate', slot),
    async applied(slot) { await effect('ledger', slot); return []; },
  };
  const persist = async (file, value) => {
    const failure = privateFault?.(file, value);
    if (failure === 'before') throw new Error('Private persistence unavailable');
    await saveJson(file, value);
    if (failure === 'after') throw new Error('Private acknowledgment lost');
  };
  const writePublic = async (file, record) => {
    const failure = publicFault?.(record);
    if (failure === 'before') throw new Error('Public persistence unavailable');
    await writeRouteRecord(file, record, policy);
    if (failure === 'after') throw new Error('Public acknowledgment lost');
  };
  let verifications = 0;
  const routeAuthority = { path, policy, fresh: true, writePublic,
    async verifyRuntime(app, selected) {
      verifications++; const saved = JSON.parse(await readFile(statePath, 'utf8'));
      assert.equal(saved.apps[app].active, selected.id);
      assert.equal(saved.deployments[selected.id].digest, selected.digest);
      const slot = saved.apps[app].slot;
      assert.equal(owners[slot]?.app, app); assert.equal(versions[slot], saved.deployments[selected.id].version);
    } };
  const create = (options = {}) => new Controller({ dir, slots, backend, persist, routeAuthority, reportStorageFailure: () => {}, ...options });
  const c = create(); await c.init();
  async function request(app = 'alpha', controller = c) {
    const id = randomUUID(), artifact = controller.artifact(id); await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, 'index.js'), `// ${id}\nexport default {fetch(){return new Response('ok')}}`);
    await writeFile(join(artifact, 'wrangler.json'), JSON.stringify({ name: app, main: 'index.js', d1_databases: [] }));
    const value = { id, app, digest: await artifactDigest(artifact), resources: { script: app, d1: [], r2: [], durable: { bindings: [] } }, migrations: [], requiredSecrets: [], status: 'pending', step: 'submitted' };
    controller.state.deployments[id] = value; await controller.save(); return value;
  }
  return { c, create, request, path, statePath, dir, root, policy, routeAuthority, backend, owners, versions, events, public: publicRecord,
    private: async () => JSON.parse(await readFile(statePath, 'utf8')), verifications: () => verifications,
    fail: kind => { fault = kind; }, failPublic: callback => { publicFault = callback; }, failPrivate: callback => { privateFault = callback; } };
}
