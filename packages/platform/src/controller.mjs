import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { artifactDigest } from '@fogd/runtime/artifact';
import { receiveArtifact } from '@fogd/runtime/manifest';
import { readJson, saveJson } from './store.mjs';
import { resourceChanges } from './resources.mjs';

export class Controller {
  constructor({ dir, slots, backend, baseDomain = 'localhost', maxPending = 20 }) {
    Object.assign(this, { dir, slots, backend, baseDomain, maxPending });
    this.queue = Promise.resolve();
    this.occupied = new Set();
  }
  exclusive(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  async init() {
    await mkdir(join(this.dir, 'artifacts'), { recursive: true });
    this.state = await readJson(join(this.dir, 'state.json'), { apps: {}, deployments: {} });
    this.state.apps = Object.assign(Object.create(null), this.state.apps);
    this.state.deployments = Object.assign(Object.create(null), this.state.deployments);
    for (const request of Object.values(this.state.deployments)) {
      if (request.status === 'activating') { request.status = 'failed'; request.error = `Controller interrupted at ${request.step}; explicit approval is required to retry`; }
    }
    for (const slot of this.slots) {
      const owner = await this.backend.owner(slot);
      if (owner) {
        this.occupied.add(slot.id);
        const app = this.state.apps[owner.app];
        if (!app) {
          // Losing local metadata must never free or silently reactivate a used slot.
          this.state.apps[owner.app] = { slot: slot.id, route: 'paused', quarantined: true, reason: 'Bucket owner has no controller record; restore controller backup' };
        } else if (app.slot !== slot.id) {
          app.quarantined = true; app.route = 'paused';
          app.reason = 'Multiple bucket slots claim this app; reconcile bucket and controller backups';
        }
      }
    }
    for (const [name, app] of Object.entries(this.state.apps)) {
      const slot = this.slots.find(s => s.id === app.slot);
      if (!slot || (await this.backend.owner(slot))?.app !== name) {
        app.quarantined = true; app.route = 'paused';
        app.reason = 'Configured slot or bucket owner is missing/mismatched; restore matching bucket, config, and controller backups';
      }
    }
    await this.save();
  }
  save() { return saveJson(join(this.dir, 'state.json'), this.state); }
  artifact(id) { return join(this.dir, 'artifacts', id); }
  available(app) {
    if (this.state.apps[app]) return this.slots.find(s => s.id === this.state.apps[app].slot);
    return this.slots.find(slot => !this.occupied.has(slot.id) && !Object.values(this.state.apps).some(a => a.slot === slot.id));
  }
  compatible(release, app) {
    if (!app) return resourceChanges(null, release.resources);
    if (app.quarantined) throw new Error(`Slot quarantined: ${app.reason || 'restore matching backups'}`);
    resourceChanges(app.resources, release.resources);
    for (const old of app.migrations || []) {
      if (!release.migrations.some(m => isDeepStrictEqual(m, old))) throw new Error(`Applied migration changed: ${old.name}`);
    }
    return resourceChanges(this.state.deployments[app.active]?.resources, release.resources);
  }
  submit(body, submitter) {
    return this.exclusive(async () => {
      if (Object.values(this.state.deployments).filter(d => ['pending', 'failed'].includes(d.status)).length >= this.maxPending) throw new Error('Pending deployment limit reached');
      const id = randomUUID(), dir = this.artifact(id);
      try {
        const release = await receiveArtifact(body, dir);
        if (!this.available(release.app)) throw new Error('No available app slots');
        const changes = this.compatible(release, this.state.apps[release.app]);
        const request = { id, ...release, resourceChanges: changes, submitter, submittedAt: new Date().toISOString(), status: 'pending', step: 'submitted' };
        this.state.deployments[id] = request;
        await this.save(); return request;
      } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
    });
  }
  async reconcile(app, slot) {
    if (!app.uncertain) return;
    const attempt = this.state.deployments[app.uncertain];
    if (!attempt || await artifactDigest(this.artifact(attempt.id)) !== attempt.digest) throw new Error('Cannot reconcile migration attempt: restore its original artifact');
    const applied = await this.backend.applied(slot, this.artifact(attempt.id), attempt.resources);
    for (const old of app.migrations || []) {
      if (!applied.some(row => row.database === old.database && row.name === old.name)) throw new Error(`Ledger lost applied migration: ${old.name}`);
    }
    const known = [...(app.migrations || []), ...attempt.migrations];
    app.migrations = applied.map(row => {
      const migration = known.find(m => m.database === row.database && m.name === row.name);
      if (!migration) throw new Error(`Unknown applied migration: ${row.name}`);
      return migration;
    });
    app.uncertain = null; await this.save();
  }
  mutate(id, digest, action) {
    return this.exclusive(async () => {
      const request = this.state.deployments[id];
      if (!request || request.digest !== digest) throw new Error('Deployment/digest mismatch');
      if (!['pending', 'failed'].includes(request.status)) throw new Error('Deployment is not pending or retryable');
      if (action === 'reject') {
        if (this.state.apps[request.app]?.uncertain === id) throw new Error('Reconcile the failed activation before rejecting its artifact');
        request.status = 'rejected'; await this.save(); return request;
      }
      const slot = this.available(request.app);
      if (!slot) throw new Error('No available app slots');
      let app = this.state.apps[request.app];
      if (app?.quarantined) throw new Error(`Slot quarantined: ${app.reason || 'restore matching backups'}`);
      if (await artifactDigest(this.artifact(id)) !== digest) throw new Error('Stored artifact digest mismatch');
      this.compatible(request, app);
      await this.backend.claim(slot, request.app);
      this.occupied.add(slot.id);
      if (!app) {
        app = { slot: slot.id, resources: request.resources, migrations: [], active: null, route: 'paused', uncertain: null };
        this.state.apps[request.app] = app; await this.save();
      }
      await this.reconcile(app, slot);
      request.resourceChanges = this.compatible(request, app);
      if (await artifactDigest(this.artifact(id)) !== digest) throw new Error('Stored artifact digest mismatch');
      request.status = 'activating'; request.error = null; app.route = 'paused';
      const step = async value => { request.step = value; await this.save(); };
      const publish = async () => {
        await step('publishing');
        request.version = await this.backend.publish(slot, this.artifact(id));
        await step('waiting-for-replicas');
        await this.backend.ready(slot, request.version);
      };
      try {
        app.resources = structuredClone(request.resources);
        await step('approved');
        if (!app.active) await publish();
        app.uncertain = id; await step('checking-migration-ledger');
        await this.reconcile(app, slot);
        app.uncertain = id; await step('migrating');
        await this.backend.migrate(slot, this.artifact(id), request.resources);
        await this.reconcile(app, slot);
        if (app.active) await publish();
        app.active = id; app.route = 'active';
        for (const other of Object.values(this.state.deployments)) {
          if (other.app === request.app && other.id !== id && ['pending', 'failed', 'active'].includes(other.status)) other.status = 'superseded';
        }
        request.status = 'active'; await step('complete');
      } catch (error) {
        request.status = 'failed'; request.error = error.message; app.route = 'paused';
        try { await this.reconcile(app, slot); } catch (reconcileError) { request.error += `; migration reconciliation pending: ${reconcileError.message}`; }
        await this.save();
      }
      return request;
    });
  }
  route(host) {
    const entry = Object.entries(this.state.apps).find(([name]) => `${name}.${this.baseDomain}` === host.toLowerCase());
    if (!entry) return { state: 'unknown' };
    const app = entry[1];
    return { state: app.route, slot: app.slot };
  }
}
