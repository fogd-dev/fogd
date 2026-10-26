import { validateCronRecoveryState, recoverCronSnapshots } from './cron-recovery.mjs';
import { replacementFor, replaceQueueApproval } from './queue-replacement.mjs';
import { validateRecoveryState, recoverQueueSnapshots } from './queue-recovery.mjs';
import { activateRelease } from './activation.mjs';
import { assertCronDecision, interruptCronActivation, recoverCronHolds, validateCronState, requireCronRuntime } from './cron-activation.mjs';
import { requireCronCapability } from './cron-dispatch.mjs';
import { assertQueueDecision, interruptQueueActivation, recoverQueueHolds, requireQueueCapability, validateQueueState } from './queue-activation.mjs';
import { inspectOwnership, reserveClaim, assertClaimRequest, rejectUnclaimed } from './claims.mjs';
import { assertLiveName, validateRetirementState } from './retirement.mjs';
import { pendingDeployments } from './capacity.mjs';
import { Credentials } from './credentials.mjs';
import { ArtifactQuota, positiveLimit, uploadBytes } from './quota.mjs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { artifactDigest } from '@fogd/runtime/artifact';
import { receiveArtifact } from '@fogd/runtime/manifest';
import { readJson, saveJson, storageFailureDiagnostic } from './store.mjs';
import { Secrets } from './secrets.mjs';
import { controllerRoutes, routingStartupError } from './controller-routes.mjs';
import { resourceChanges } from './resources.mjs';
import { setArtifactPin } from './artifact-pins.mjs';
import { artifactPruneStatus, assertArtifactMutationAllowed } from './artifact-prune-state.mjs';
import { pruneArtifacts, resumeArtifactPrune } from './artifact-prune.mjs';

export class Controller {
  #persist;
  #storageFailed = false;
  #storageCause;
  #reportStorageFailure;
  #recoveryPending = true;
  #ownershipChecked = false;
  #routingServiceRestricted = false;
  constructor({ dir, slots, backend, baseDomain = 'localhost', maxPending = 20, maxPendingPerCredential = 5, maxArtifactBytes = 256 * 1024 * 1024, persist = saveJson, reportStorageFailure = diagnostic => console.error('fogd controller storage failure', diagnostic), clock = Date.now, queueApps = false, cronApps = false, routeAuthority = null }) {
    Object.assign(this, { dir, slots, backend, baseDomain, maxPending });
    this.clock = clock;
    if (typeof queueApps !== 'boolean') throw new Error('Queue admission setting must be boolean');
    this.queueApps = queueApps;
    if (typeof cronApps !== 'boolean') throw new Error('Scheduled admission setting must be boolean');
    this.cronApps = cronApps;
    this.#persist = persist;
    this.#reportStorageFailure = reportStorageFailure;
    this.maxPending = positiveLimit(maxPending, 'Pending deployment limit');
    this.maxPendingPerCredential = positiveLimit(maxPendingPerCredential, 'Per-credential pending limit');
    this.quota = new ArtifactQuota(maxArtifactBytes);
    const persistMetadata = (path, value) => this.#saveMetadata(path, value);
    this.credentials = new Credentials(dir, persistMetadata);
    this.secrets = new Secrets(dir, persistMetadata);
    this.queue = Promise.resolve();
    this.occupied = new Set();
    this.bucketOwners = new Map();
    this.routes = controllerRoutes(this, routeAuthority);
  }
  // A pending prune blocks ordinary work here rather than in assertStorage, so saves and owner
  // CSRF reads still work; only the prune operations opt in.
  exclusive(task, { artifactPrune = false } = {}) {
    const result = this.queue.then(() => {
      this.assertStorage();
      if (!artifactPrune) assertArtifactMutationAllowed(this.state);
      return task();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  async init() {
    this.assertStorage();
    if (this.cronApps) requireCronRuntime(this.backend.crons);
    const missing = Symbol('missing controller state');
    const retained = await readJson(join(this.dir, 'state.json'), missing);
    this.routes.assertEnrollment(retained === missing ? null : retained);
    this.state = retained === missing ? { apps: {}, deployments: {} } : retained;
    this.state.apps = Object.assign(Object.create(null), this.state.apps);
    this.state.deployments = Object.assign(Object.create(null), this.state.deployments);
    validateRetirementState(this.state, this.slots, { durableRoutes: this.routes.durable });
    validateQueueState(this.state);
    validateCronState(this.state, this.backend.crons);
    validateRecoveryState(this.state);
    validateCronRecoveryState(this.state);
    await this.routes.open();
    await this.secrets.init();
    await this.credentials.init();
    await mkdir(join(this.dir, 'artifacts'), { recursive: true });
    await this.quota.init(join(this.dir, 'artifacts'), this.state.deployments);
    for (const request of Object.values(this.state.deployments)) {
      if (request.status === 'activating') { interruptQueueActivation(this.state.apps[request.app], request); interruptCronActivation(this.state.apps[request.app], request); request.status = 'failed'; request.error = `Controller interrupted at ${request.step}; explicit approval is required to retry`; }
    }
    await inspectOwnership(this);
    this.#ownershipChecked = true;
    await this.#recoverStartup();
  }
  async #recoverStartup() {
    await this.routes.reconcilePaused();
    await this.save();
    if (!this.routes.recoveryAllowed()) return;
    await recoverQueueHolds(this);
    await recoverCronHolds(this);
    await recoverQueueSnapshots(this);
    await recoverCronSnapshots(this);
    this.#recoveryPending = false;
  }

  get routingServiceRestricted() { return this.#routingServiceRestricted; }
  restrictRoutingService() {
    if (!this.routingRecoveryAvailable) throw routingStartupError();
    this.#routingServiceRestricted = true;
  }
  get routingRecoveryAvailable() { return this.routes.durable && this.#ownershipChecked; }
  get routingStartupComplete() { return this.#ownershipChecked && !this.#recoveryPending; }
  assertRoutingStartup(requireComplete = false) {
    if (!this.#ownershipChecked || requireComplete && this.#recoveryPending) throw routingStartupError();
  }
  assertStorage() {
    this.routes?.assertStorage();
    if (this.#storageFailed) {
      const error = new Error('Controller metadata write failed; restart to reload durable state before retrying', { cause: this.#storageCause });
      error.code = 'CONTROLLER_STORAGE_UNCERTAIN';
      throw error;
    }
  }
  save() { return this.#saveMetadata(join(this.dir, 'state.json'), this.state); }
  async #saveMetadata(path, value) {
    this.assertStorage();
    try { await this.#persist(path, value); }
    catch (error) {
      this.#storageFailed = true; this.#storageCause = error;
      // Diagnostic failures must not mask the reload requirement. Never log
      // arbitrary messages, paths, or values from the failed metadata write.
      try { this.#reportStorageFailure(storageFailureDiagnostic(error)); } catch {}
      this.assertStorage();
    }
  }
  artifact(id) { return join(this.dir, 'artifacts', id); }
  available(app) {
    assertLiveName(this.state, app);
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
  assertAdmission(request, action = 'submit') {
    if (action === 'reject') return;
    if (action === 'approve' && request.status === 'failed' && Object.hasOwn(request, 'secretRevision')) return;
    if (request.resources?.queues && !this.queueApps) throw new Error('Queue applications are not enabled on this installation');
    if (request.resources?.crons && !this.cronApps) throw new Error('Scheduled applications are not enabled on this installation');
  }
  submit(body, submitter) {
    return this.exclusive(async () => {
      if (submitter !== 'team-token') this.credentials.requireScope(submitter, body.app);
      const pending = pendingDeployments(this).filter(d => d.submitter === submitter);
      if (submitter !== 'team-token' && pending.length >= this.maxPendingPerCredential) throw new Error('Credential pending deployment limit reached');
      const bytes = uploadBytes(body); this.quota.admit(bytes);
      if (pendingDeployments(this).length >= this.maxPending) throw new Error('Pending deployment limit reached');
      const id = randomUUID(), dir = this.artifact(id);
      try {
        const release = await receiveArtifact(body, dir, { cronApps: this.cronApps });
        this.assertAdmission(release);
        if (release.resources.crons && submitter === 'team-token') throw new Error('Scheduled applications require an app-scoped deployment credential');
        if (!this.available(release.app)) throw new Error('No available app slots');
        const changes = this.compatible(release, this.state.apps[release.app]);
        const request = { id, ...release, resourceChanges: changes, submitter, submittedAt: new Date().toISOString(), status: 'pending', step: 'submitted' };
        requireCronCapability(this.state, request.resources);
        requireQueueCapability(this.state, request.resources);
        this.state.deployments[id] = request;
        await this.save(); this.quota.used += bytes; return request;
      } catch (error) { this.assertStorage(); delete this.state.deployments[id]; await rm(dir, { recursive: true, force: true }); throw error; }
    });
  }
  async reconcile(app, slot) {
    this.assertStorage();
    try { await this.reconcileLedger(app, slot); }
    catch (error) {
      if (app.privateConfiguration) throw new Error('Private migration reconciliation failed; runtime diagnostics are withheld');
      throw error;
    }
  }
  async reconcileLedger(app, slot) {
    if (!app.uncertain) return;
    const attempt = this.state.deployments[app.uncertain];
    if (!attempt || await artifactDigest(this.artifact(attempt.id)) !== attempt.digest) throw new Error('Cannot reconcile migration attempt: restore its original artifact');
    await this.routes.beforeEffect(app, slot);
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
  issueCredential(name, apps) { return this.exclusive(() => {
    if (Array.isArray(apps)) apps.forEach(app => assertLiveName(this.state, app));
    return this.credentials.issue(name, apps);
  }); }
  revokeCredential(id) { return this.exclusive(() => this.credentials.revoke(id)); }
  replaceSecrets(app, values) { return this.exclusive(() => { assertLiveName(this.state, app); return this.secrets.replace(app, values); }); }
  mutate(id, digest, action, secretRevision, replaces) {
    return this.exclusive(async () => {
      await this.routes.checkReady();
      const request = this.state.deployments[id];
      if (!request || request.digest !== digest) throw new Error('Deployment/digest mismatch');
      assertClaimRequest(this.state, request);
      assertLiveName(this.state, request.app);
      if (!['pending', 'failed'].includes(request.status)) throw new Error('Deployment is not pending or retryable');
      this.assertAdmission(request, action);
      if (action !== 'approve' && replaces !== undefined) throw new Error('Only approval can replace a held activation');
      const backgroundReplaces = action === 'approve' ? this.routes.prepareApproval(request, replaces) : replaces;
      assertCronDecision(this.state.apps[request.app], request, action, backgroundReplaces, this.backend.crons);
      const previous = replacementFor(this, request, backgroundReplaces);
      assertQueueDecision(this.state.apps[request.app], request, action, Boolean(previous));
      if (action === 'reject') return this.#reject(request);
      const slot = this.available(request.app);
      if (!slot) throw new Error('No available app slots');
      let app = this.state.apps[request.app];
      if (app?.quarantined) throw new Error(`Slot quarantined: ${app.reason || 'restore matching backups'}`);
      if (app?.claim && app.claim.deployment !== id) throw new Error('Retry the original approved ownership claim before activating another deployment');
      if (await artifactDigest(this.artifact(id)) !== digest) throw new Error('Stored artifact digest mismatch');
      this.compatible(request, app);
      const selected = await this.secrets.select(request, secretRevision);
      if (previous) { await this.routes.beforeEffect(app, slot); await replaceQueueApproval(this, request, previous, app, slot, selected); }
      return this.prepareActivation(request, app, slot, selected, replaces);
    });
  }
  async #reject(request) {
    this.routes.assertReject(request);
    await rejectUnclaimed(this, request);
    if (this.state.apps[request.app]?.uncertain === request.id) throw new Error('Reconcile the failed activation before rejecting its artifact');
    request.status = 'rejected'; await this.save(); return request;
  }
  async #withholdActivation(request, app, slot, selected, replaces) {
    await this.routes.checkReady();
    const prior = { request: structuredClone(request), app: app && structuredClone(app), requirements: this.state.requirements && [...this.state.requirements] };
    try {
      requireCronCapability(this.state, request.resources); requireQueueCapability(this.state, request.resources);
      request.secretRevision = selected.revision;
      request.status = 'activating'; request.step = 'preparing-activation'; request.error = null;
      if (!app) app = reserveClaim(this.state, request, slot, Boolean(selected.revision));
      app.privateConfiguration ||= Boolean(selected.revision); app.route = 'paused';
      await this.routes.withhold(request, replaces); return app;
    } catch (error) {
      this.assertStorage();
      for (const key of Object.keys(request)) delete request[key]; Object.assign(request, prior.request);
      if (prior.app) { for (const key of Object.keys(app)) delete app[key]; Object.assign(app, prior.app); }
      else delete this.state.apps[request.app];
      if (prior.requirements) this.state.requirements = prior.requirements; else delete this.state.requirements;
      throw error;
    }
  }
  async prepareActivation(request, app, slot, selected, replaces) {
    const retrying = app?.uncertain === request.id;
    app = await this.#withholdActivation(request, app, slot, selected, replaces);
    try {
      await this.backend.claim(slot, request.app, { unpublished: Boolean(app.claim) });
      this.occupied.add(slot.id);
      this.bucketOwners.set(slot.id, request.app);
      if (app.claim) { delete app.claim; await this.save(); }
      if (!request.resources.queues && !request.resources.crons) await this.reconcile(app, slot);
      request.resourceChanges = this.compatible(request, app);
      if (await artifactDigest(this.artifact(request.id)) !== request.digest) throw new Error('Stored artifact digest mismatch');
    } catch (error) {
      this.assertStorage();
      request.status = 'failed';
      request.error = selected.revision || app?.privateConfiguration ? 'Private activation preparation failed; runtime diagnostics are withheld' : error.message;
      await this.save();
      throw new Error(request.error);
    }
    return activateRelease(this, request, app, slot, selected, retrying);
  }
  setArtifactPin(id, digest, kept) { return setArtifactPin(this, id, digest, kept); }
  pruneArtifacts(plan) { return this.exclusive(() => pruneArtifacts(this, plan), { artifactPrune: true }); }
  resumeArtifactPrune(id) { return this.exclusive(() => resumeArtifactPrune(this, id), { artifactPrune: true }); }
  artifactPruneStatus() { return this.exclusive(() => artifactPruneStatus(this.state), { artifactPrune: true }); }
  preflightIngress(input) { return this.exclusive(() => this.routes.preflight(input)); }
  decideRoute(name, action, input) { return this.exclusive(async () => {
    const result = await this.routes.decide(name, action, input);
    if (this.#recoveryPending && this.#ownershipChecked && ['reconcile', 'withhold-pending'].includes(action)) await this.#recoverStartup();
    return this.routes.durable ? this.routes.view(name) : result;
  }); }
  route(host) {
    if (this.routes.durable) throw new Error('Controller route lookup is disabled for durable authority');
    const entry = Object.entries(this.state.apps).find(([name]) => `${name}.${this.baseDomain}` === host.toLowerCase());
    if (!entry || entry[1].retirement) return { state: 'unknown' };
    const app = entry[1];
    return { state: this.#storageFailed ? 'paused' : app.route, slot: app.slot };
  }
}
