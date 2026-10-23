import { isDeepStrictEqual } from 'node:util';
import { preflightRoutes } from './route-preflight.mjs';
import { assertRouteEnrollmentTargets } from './route-enrollment.mjs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep, dirname } from 'node:path';
import { encodeRouteRecord, routeRecordFilename } from '@fogd/runtime/route-record';
import { RoutePublication, applicationWithheld, completedRoute, routeHold, routeAuthorityJournal } from './route-publication.mjs';

function containsPath(parent, child) {
  const path = relative(parent, child);
  return !path || path !== '..' && !path.startsWith('..' + sep);
}
export function routeEnrollmentRequired() {
  return Object.assign(new Error('Durable routing requires retained enrollment state; initialize through stopped route enrollment before ordinary startup'), { code: 'ROUTE_ENROLLMENT_REQUIRED' });
}

export function routingStartupError(cause) {
  return Object.assign(new Error('HTTP authority could not be reconciled; keep ingress stopped and resolve the pending publication or restore matching storage', { cause }), { code: 'ROUTE_STARTUP_UNRECONCILED' });
}

class LookupRoutes {
  durable = false;
  constructor(controller) { this.controller = controller; }
  async open() { if (this.controller.state.routeAuthority) throw new Error('Controller state requires durable route authority'); }
  assertEnrollment() {}
  assertStorage() {}
  async checkReady() {}
  async snapshotReady() {}
  beforeEffect() {}
  assertReject() {}
  decide() { throw new Error('Durable HTTP routing is not configured'); }
  preflight() { throw new Error('Durable HTTP routing is not configured'); }
  async verifyRecovery() {}
  prepareApproval(_request, replaces) { return replaces; }
  releaseClaim() {}
  recoveryAllowed() { return true; }
  async reconcilePaused() {}
  withhold() { return this.controller.save(); }
  complete() { return this.controller.save(); }
  persistBackground(app, field, next) {
    delete app[field === 'delivery' ? 'queueSnapshot' : 'cronSnapshot'];
    app[field] = next; return this.controller.save();
  }
}

class DurableRoutes extends LookupRoutes {
  durable = true;
  constructor(controller, options) {
    super(controller); this.options = { ...options, policy: structuredClone(options.policy) };
    if (Object.hasOwn(options, 'fresh')) throw new Error('Controller routing does not accept initialization flags; use stopped route enrollment');
    const { path, policy, verifyRuntime } = options;
    if (typeof path !== 'string' || !isAbsolute(path) || !path.endsWith('/' + routeRecordFilename) || typeof verifyRuntime !== 'function') throw new Error('Durable routing needs an absolute routes.json authority path and read-only runtime verification');
    if (containsPath(controller.dir, dirname(path)) || containsPath(dirname(path), controller.dir)) throw new Error('Public route authority must be outside private controller storage');
    encodeRouteRecord({ schema: 1, installation: policy?.installation, revision: '1', routes: [{ host: `probe.${controller.baseDomain}`, state: 'withheld', slot: policy?.slots?.[0] }] }, policy);
    if (JSON.stringify([...policy.slots].sort()) !== JSON.stringify(controller.slots.map(slot => slot.id).sort())) throw new Error('Route policy must match the configured fleets');
  }
  assertEnrollment(state) {
    if (!state?.routeAuthority) throw routeEnrollmentRequired();
    routeAuthorityJournal(state, this.options.policy);
  }
  async open() {
    await this.#separateStorage();
    const controller = this.controller, state = controller.state;
    await assertRouteEnrollmentTargets(state.routeEnrollment, controller.dir, dirname(this.options.path));
    this.publication = new RoutePublication({ ...this.options, state, domain: controller.baseDomain, savePrivate: () => controller.save() });
    if (!state.routeAuthority) throw routeEnrollmentRequired();
    await this.publication.inspect();
    if (state.routeAuthority.pending?.kind === 'active') {
      try { this.#assertPendingActive(state.routeAuthority.pending); }
      catch (cause) {
        const pending = state.routeAuthority.pending;
        await this.publication.withholdPendingActive({ intent: pending.id, ...pending.approval });
        this.startupError = routingStartupError(cause); throw this.startupError;
      }
      return;
    }
    if (state.routeAuthority.pending) await this.publication.resumeWithholding();
    else await this.publication.verifySettled();
  }
  async #separateStorage() {
    const [privateDir, publicDir] = await Promise.all([realpath(this.controller.dir), realpath(dirname(this.options.path))]);
    if (containsPath(privateDir, publicDir) || containsPath(publicDir, privateDir)) throw new Error('Public route authority must be outside private controller storage');
  }
  assertStorage() { this.publication?.assertNotFailed(); }
  async checkReady() { this.controller.assertRoutingStartup(true); this.controller.assertStorage(); if (this.startupError) throw this.startupError; this.publication.assertReady(); await this.publication.verifySettled(); }
  snapshotReady(name, active) { this.controller.assertRoutingStartup(true); this.controller.assertStorage(); return this.publication.assertServing(name, active.id, active.digest); }
  recoveryAllowed() { return this.controller.state.routeAuthority.pending === null; }
  async reconcilePaused() {
    this.startupError = null;
    const state = this.controller.state, pending = state.routeAuthority.pending;
    if (pending?.kind === 'active') {
      if (!applicationWithheld(state.apps[pending.app])) {
        const observed = await this.publication.inspect();
        if (observed.record.routes.some(route => this.#needsWithholding(route))) { this.startupError = routingStartupError(); await this.controller.save(); throw this.startupError; }
        return;
      }
      await this.publication.withholdPendingActive({ intent: pending.id, ...pending.approval });
    }
    const observed = await this.publication.inspect();
    for (const route of observed.record.routes) await this.#reconcileRoute(route);
    if (this.startupError) throw this.startupError;
  }
  #assertPendingActive(pending) {
    const domain = this.controller.baseDomain;
    const route = pending.record.routes.find(route => route.host === `${pending.app}.${domain}`);
    if (!isDeepStrictEqual(completedRoute(this.controller.state, pending.app, domain), route)) throw new Error('Pending route differs from its completed approval');
  }
  #routeApplication(route) {
    const state = this.controller.state, domain = this.controller.baseDomain;
    const name = route.host.slice(0, -domain.length - 1), app = state.apps[name];
    if (!route.host.endsWith('.' + domain) || !app || app.retirement || app.slot !== route.slot) throw new Error('Public route authority differs from controller ownership');
    if (route.state === 'active' && !isDeepStrictEqual(completedRoute(state, name, domain), route)) throw new Error('Public route authority differs from its completed approval');
    return { name, app };
  }
  #needsWithholding(route) {
    if (route.state !== 'active') return false;
    try { return applicationWithheld(this.#routeApplication(route).app); }
    catch { return true; }
  }
  async #reconcileRoute(route) {
    let target;
    try { target = this.#routeApplication(route); }
    catch (cause) {
      await this.publication.withholdHost(route.host);
      this.startupError = routingStartupError(cause); return;
    }
    const { name, app } = target, state = this.controller.state;
    const recovering = app.queueRecovery?.status === 'pending' || app.cronRecovery?.status === 'pending';
    if (recovering && !routeHold(state.routeAuthority.holds, name)) {
      const active = completedRoute(state, name, this.controller.baseDomain);
      await this.publication.withhold(name, active.submission, active.digest);
    } else if (route.state === 'active' && applicationWithheld(app)) await this.publication.withdraw(name);
  }
  preflight(input) { return preflightRoutes(this.controller, this, input); }
  async view(name) {
    const observed = await this.publication.inspect(), state = this.controller.state;
    if (!state.apps[name] || state.apps[name].retirement) throw new Error('Live application is unavailable');
    const route = observed.record.routes.find(route => route.host === `${name}.${this.controller.baseDomain}`);
    const pending = state.routeAuthority.pending;
    return { app: name, state: route?.state || 'unknown', revision: observed.record.revision,
      active: route?.state === 'active' ? { deployment: route.submission, digest: route.digest } : null,
      hold: routeHold(state.routeAuthority.holds, name) || null, startupBlocked: Boolean(this.startupError) || !this.controller.routingStartupComplete,
      pending: pending ? { intent: pending.id, kind: pending.kind, app: pending.app, approval: pending.approval } : null };
  }
  async decide(name, action, input) {
    this.controller.assertStorage();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('HTTP routing input must select a deployment and digest');
    const selected = { id: input.deployment, digest: input.digest };
    if (action === 'pause') {
      const pending = this.controller.state.routeAuthority.pending;
      if (pending?.kind === 'active') throw new Error(pending.app === name ? 'Select withhold-pending and the exact pending publication to pause HTTP' : 'Resolve the other application publication before pausing this app');
      const state = this.controller.state, active = state.deployments[state.apps[name]?.active];
      if (!active || active.id !== selected.id || active.digest !== selected.digest || active.app !== name || active.status !== 'active' || active.step !== 'complete') throw new Error('HTTP pause requires the current completed approval');
      await this.publication.withdraw(name);
    } else if (action === 'resume') {
      this.controller.assertRoutingStartup(true);
      if (this.startupError) throw this.startupError;
      await this.publication.resume(name, selected, this.options.verifyRuntime);
    }
    else await this.#pendingDecision(name, action, input.intent, selected);
    return this.view(name);
  }
  #pendingDecision(name, action, intent, selected) {
    if (this.controller.state.routeAuthority.pending?.app !== name) throw new Error('Select the application owning the pending publication');
    const input = { intent, ...selected };
    if (action === 'reconcile') { this.controller.assertRoutingStartup(); return this.publication.reconcileActive(input, this.options.verifyRuntime); }
    if (action === 'withhold-pending') return this.publication.withholdPendingActive(input);
    throw new Error('Invalid HTTP routing decision');
  }
  assertReject(request) {
    const state = this.controller.state, app = state.apps[request.app];
    if (routeHold(state.routeAuthority.holds, request.app)?.id === request.id && app?.claim?.deployment !== request.id) throw new Error('Resolve the held HTTP approval before rejecting its artifact');
  }
  async verifyRecovery(name, request) {
    this.controller.assertRoutingStartup(true); this.controller.assertStorage();
    await this.publication.assertWithheld(name, request.id, request.digest);
    try { await this.options.verifyRuntime(name, { id: request.id, digest: request.digest }); }
    catch (cause) { throw new Error('HTTP runtime identity/readiness is unconfirmed', { cause }); }
  }
  prepareApproval(request, replaces) {
    const app = this.controller.state.apps[request.app], held = routeHold(this.controller.state.routeAuthority.holds, request.app);
    if (replaces !== undefined) this.#replacement(request, replaces);
    if (held && held.id !== request.id && replaces === undefined) throw new Error('Select the held HTTP approval before a corrected release');
    return app?.delivery?.hold || app?.dispatch?.hold ? replaces : undefined;
  }
  #replacement(request, replaces) {
    const held = routeHold(this.controller.state.routeAuthority.holds, request.app);
    if (!replaces || typeof replaces !== 'object' || Object.keys(replaces).length !== 2 || !Object.hasOwn(replaces, 'deployment') || !Object.hasOwn(replaces, 'digest')) throw new Error('HTTP replacement requires the held deployment and digest');
    const expected = request.routeReplaces;
    if (expected && (expected.deployment !== replaces.deployment || expected.digest !== replaces.digest)) throw new Error('HTTP replacement predecessor changed');
    if (held?.id === request.id && expected) return;
    if (held?.id !== replaces.deployment || held.digest !== replaces.digest) throw new Error('HTTP replacement must select the exact held approval');
  }
  async beforeEffect(app, slot) {
    this.controller.assertRoutingStartup(); this.controller.assertStorage();
    const state = this.controller.state, name = Object.keys(state.apps).find(name => state.apps[name] === app);
    const selected = routeHold(state.routeAuthority.holds, name);
    if (!selected || !slot || app.slot !== slot.id) throw new Error('Backend change requires the app approval and withheld fleet');
    await this.publication.assertWithheld(name, selected.id, selected.digest);
  }
  async persistBackground(app, field, next) {
    const previous = app[field], snapshotField = field === 'delivery' ? 'queueSnapshot' : 'cronSnapshot';
    const hadSnapshot = Object.hasOwn(app, snapshotField), snapshot = app[snapshotField];
    delete app[snapshotField]; app[field] = next;
    try {
      if (previous.hold && next.hold && previous.hold !== next.hold) {
        const request = this.controller.state.deployments[next.hold];
        await this.withhold(request, request.replaces); return;
      }
      await this.controller.save();
    } catch (error) {
      this.controller.assertStorage(); app[field] = previous;
      if (hadSnapshot) app[snapshotField] = snapshot;
      throw error;
    }
  }
  releaseClaim(request) { return this.publication.releaseClaim(request.app, request.id, request.digest); }
  withhold(request, replaces) {
    let selected = null;
    if (replaces !== undefined) {
      this.#replacement(request, replaces);
      request.routeReplaces ||= structuredClone(replaces);
      if (routeHold(this.controller.state.routeAuthority.holds, request.app)?.id !== request.id) selected = { id: replaces.deployment, digest: replaces.digest };
    }
    return this.publication.withhold(request.app, request.id, request.digest, { replaces: selected });
  }
  complete(request) { return this.publication.activate(request.app); }
}

export function controllerRoutes(controller, options) {
  if (options === null || options === undefined) return new LookupRoutes(controller);
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid durable routing configuration');
  return new DurableRoutes(controller, options);
}
