import { archiveHeld } from './app-archive-gate.mjs';
import { encodeRouteRecord, isRouteRevision } from '@fogd/runtime/route-record';
import { readRouteRecord, routeRecordDigest, writeRouteRecord, createRouteRecord } from './route-record-store.mjs';

export const routeHold = (holds, name) => Object.hasOwn(holds, name) ? holds[name] : undefined;

export const routeAuthorityCapability = 'fogd-route-authority-v1';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const pinnedSecret = request => Object.hasOwn(request, 'secretRevision') && (request.secretRevision === null || uuid(request.secretRevision));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const approvedReference = value => keys(value, ['id', 'digest']) && uuid(value.id) && hash(value.digest);
function intentShape(value) {
  const fields = ['id', 'kind', 'app', 'approval', 'previous', 'record', 'digest'];
  if (value?.kind === 'withdraw') fields.push('superseded');
  if (value?.kind === 'quarantine') fields.push('host');
  return keys(value, fields) && (value.kind !== 'quarantine' || typeof value.host === 'string') && ['initialize', 'withhold', 'active', 'withdraw', 'release-claim', 'quarantine'].includes(value.kind) && typeof value.id === 'string' && object(value.record) && hash(value.digest) &&
    (value.approval === null || approvedReference(value.approval));
}
const validReference = value => keys(value, ['revision', 'digest']) && isRouteRevision(value.revision) && hash(value.digest);
const failure = cause => Object.assign(new Error('Route publication is uncertain; reload durable state and reconcile before changing the backend', { cause }), { code: 'ROUTE_PUBLICATION_UNCERTAIN' });
const same = (left, right) => Boolean(left && right && left.revision === right.revision && left.digest === right.digest);
const reference = observed => observed && ({ revision: observed.record.revision, digest: observed.digest });
function approval(state, app, id, digest, statuses) {
  const request = state.deployments[id];
  if (!request || request.app !== app || request.id !== id || request.digest !== digest || !statuses.includes(request.status) || !uuid(request.id) || !pinnedSecret(request)) throw new Error('Route publication requires the exact pinned approval');
  if (request.status === 'active' && (state.apps[app]?.active !== id || request.step !== 'complete')) throw new Error('Route publication requires the current completed approval');
  return { id, digest };
}
export function applicationWithheld(app) {
  const holds = [app.quarantined, app.uncertain, app.claim, app.delivery?.hold, app.dispatch?.hold];
  const recovering = [app.queueRecovery, app.cronRecovery].some(record => record && record.status !== 'acknowledged');
  return app.route !== 'active' || archiveHeld(app) || holds.some(Boolean) || recovering;
}
export function completedRoute(state, name, domain) {
  const app = state.apps[name], request = state.deployments[app?.active];
  if (!app || app.retirement || request?.step !== 'complete') throw new Error('Active route has no completed pinned approval');
  const selected = approval(state, name, app.active, request.digest, ['active']);
  return { host: `${name}.${domain}`, state: 'active', slot: app.slot, submission: selected.id, digest: selected.digest };
}
function projectedRoute(name, app, state, domain) {
  if (!object(app)) throw new Error('Route application is unavailable');
  if (app.retirement) throw new Error('Retired apps cannot publish live route authority');
  const route = { host: `${name}.${domain}`, state: 'withheld', slot: app.slot };
  if (applicationWithheld(app)) return route;
  return completedRoute(state, name, domain);
}

export function routeAuthorityJournal(state, policy) {
  const value = state.routeAuthority;
  if (!keys(value, ['schema', 'installation', 'holds', 'settled', 'pending']) || value.schema !== 1 || value.installation !== policy.installation || !Array.isArray(state.requirements) || !state.requirements.includes(routeAuthorityCapability) ||
    !object(value.holds) || !Object.values(value.holds).every(approvedReference) ||
    (value.pending !== null && !intentShape(value.pending)) ||
    (value.settled !== null && !validReference(value.settled)) || (value.settled === null && value.pending?.kind !== 'initialize')) throw failure();
  return value;
}

// The controller owns application state and serializes backend work. This module
// serializes only the short, two-store route publication decisions.
export class RoutePublication {
  #failed = false;
  #verified = false;
  #queue = Promise.resolve();
  constructor({ state, path, policy, domain, savePrivate, writePublic = (path, record) => writeRouteRecord(path, record, policy), createPublic = (path, record) => createRouteRecord(path, record, policy) }) {
    Object.assign(this, { state, path, policy, domain, savePrivate, writePublic, createPublic });
    encodeRouteRecord({ schema: 1, installation: policy.installation, revision: '0', routes: [] }, policy);
    if (!object(state) || !object(state.apps) || !object(state.deployments)) throw failure();
    if (state.routeAuthority) this.#journal();
    if (typeof savePrivate !== 'function') throw new Error('Route publication needs durable private persistence');
  }
  #journal() { return routeAuthorityJournal(this.state, this.policy); }
  assertNotFailed() { if (this.#failed) throw failure(); }
  assertReady() {
    this.assertNotFailed();
    const journal = this.#journal();
    if (!this.#verified || !journal.settled || journal.pending) throw failure();
  }
  inspect() {
    return this.#exclusive(async () => {
      if (this.#journal().pending) this.#pending(['initialize', 'withhold', 'active', 'withdraw', 'release-claim', 'quarantine']);
      return this.#current();
    });
  }
  verifySettled() {
    return this.#exclusive(async () => {
      if (this.#journal().pending) throw failure();
      await this.#current(); this.#verified = true;
    });
  }
  #exclusive(task) {
    const result = this.#queue.then(async () => { this.assertNotFailed(); return task(); });
    this.#queue = result.catch(() => {}); return result;
  }
  async #durable(task) {
    try { return await task(); } catch (cause) { this.#failed = true; throw failure(cause); }
  }
  #record(revision, previous = null, app = null) {
    if (app === null) return { schema: 1, installation: this.policy.installation, revision, routes: [] };
    return this.#replaceRoute(revision, previous, projectedRoute(app, this.state.apps[app], this.state, this.domain));
  }
  async #writePending(pending, create = false) {
    await this.#durable(() => (create ? this.createPublic : this.writePublic)(this.path, pending.record));
    const observed = await this.#current();
    if (!same(reference(observed), { revision: pending.record.revision, digest: pending.digest })) { this.#failed = true; throw failure(); }
  }
  async #settle(pending) {
    const holds = { ...this.state.routeAuthority.holds };
    if (pending.kind === 'withhold' && pending.approval) holds[pending.app] = { ...pending.approval };
    if (['active', 'release-claim'].includes(pending.kind)) delete holds[pending.app];
    if ((pending.kind === 'withdraw' || pending.kind === 'withhold' && !pending.approval) && this.state.apps[pending.app]) this.state.apps[pending.app].route = 'paused';
    this.state.routeAuthority = { schema: 1, installation: this.policy.installation, holds,
      settled: { revision: pending.record.revision, digest: pending.digest }, pending: null };
    await this.#durable(() => this.savePrivate());
    this.#verified = true;
  }
  async #current() {
    const journal = this.#journal();
    const observed = await this.#durable(() => readRouteRecord(this.path, this.policy));
    const superseded = journal.pending?.kind === 'withdraw' && { revision: journal.pending.superseded.record.revision, digest: journal.pending.superseded.digest };
    const actual = reference(observed), target = journal.pending && { revision: journal.pending.record.revision, digest: journal.pending.digest };
    const freshMissing = actual === null && journal.settled === null && journal.pending?.kind === 'initialize';
    if (!freshMissing && !same(actual, journal.settled) && !same(actual, target) && !same(actual, superseded)) { this.#failed = true; throw failure(); }
    return observed;
  }
  initialize() {
    return this.#exclusive(async () => {
      if (this.state.routeAuthority || Object.keys(this.state.apps).length || Object.keys(this.state.deployments).length) throw new Error('Route initialization requires fresh private state');
      if (await this.#durable(() => readRouteRecord(this.path, this.policy))) throw new Error('Route initialization cannot overwrite existing authority');
      const record = this.#record('0'), pending = { id: 'initialize:0', kind: 'initialize', app: null, approval: null, previous: null, record, digest: routeRecordDigest(record, this.policy) };
      this.state.requirements = [...new Set([...(this.state.requirements || []), routeAuthorityCapability])];
      this.state.routeAuthority = { schema: 1, installation: this.policy.installation, settled: null, holds: {}, pending };
      await this.#durable(() => this.savePrivate());
      await this.#writePending(pending, true);
      await this.#settle(pending);
    });
  }
  async #publish(kind, app, selected, replaces = null) {
    this.assertReady();
    if (selected && kind === 'withhold') this.#selectHold(app, selected, replaces);
    const previous = (await this.#current()).record;
    if (kind === 'active') this.#requireHold(app, selected, previous);
    const revision = String(BigInt(this.state.routeAuthority.settled.revision) + 1n);
    const record = kind === 'withhold' ? this.#withholding(revision, previous, app, selected) : this.#record(revision, previous, app);
    const route = record.routes.find(value => value.host === `${app}.${this.domain}`);
    if (!route || route.state !== (kind === 'active' ? 'active' : 'withheld')) throw new Error('Route publication state does not match the requested decision');
    const pending = { id: `${kind}:${revision}`, kind, app, approval: selected, previous, record, digest: routeRecordDigest(record, this.policy) };
    if (kind === 'withhold' && this.state.apps[app]) this.state.apps[app].route = 'paused';
    await this.#commitPending(pending);
  }
  async #commitPending(pending) {
    this.state.routeAuthority.pending = pending;
    await this.#durable(() => this.savePrivate());
    await this.#writePending(pending);
    await this.#settle(pending);
  }

  #requireHold(app, selected, record) {
    const held = routeHold(this.#journal().holds, app), route = record.routes.find(value => value.host === `${app}.${this.domain}`);
    if (held?.id !== selected.id || held.digest !== selected.digest || route?.state !== 'withheld' || route.slot !== this.state.apps[app]?.slot) throw new Error('Active publication requires withholding for the exact approval');
  }
  assertServing(app, id, digest) {
    return this.#exclusive(async () => {
      this.assertReady(); approval(this.state, app, id, digest, ['active']);
      const current = await this.#current(), route = current.record.routes.find(route => route.host === `${app}.${this.domain}`);
      if (route?.state !== 'active' || route.submission !== id || route.digest !== digest || route.slot !== this.state.apps[app]?.slot) throw new Error('Snapshot requires active public HTTP routing');
    });
  }
  assertWithheld(app, id, digest) {
    return this.#exclusive(async () => {
      this.assertReady();
      const selected = approval(this.state, app, id, digest, ['activating', 'failed', 'active']);
      this.#requireHold(app, selected, (await this.#current()).record);
    });
  }
  #selectHold(app, selected, replaces) {
    const held = routeHold(this.#journal().holds, app);
    if (!held || held.id === selected.id && held.digest === selected.digest) {
      if (replaces !== null) throw new Error('No different approval hold matches the replacement selection');
      return;
    }
    if (!approvedReference(replaces) || replaces.id !== held.id || replaces.digest !== held.digest || this.state.deployments[selected.id]?.status !== 'activating') throw new Error('Select the exact different approval hold before replacement');
    approval(this.state, app, held.id, held.digest, ['failed', 'superseded', 'active']);
  }
  withhold(app, id, digest, { replaces = null } = {}) {
    return this.#exclusive(() => this.#publish('withhold', app, approval(this.state, app, id, digest, ['activating', 'failed', 'active']), replaces));
  }
  withdraw(app) {
    return this.#exclusive(() => this.#publish('withhold', app, null));
  }
  // Completion path only: the owner has just finished backend readiness.
  // Operator unpause and publication recovery use resume/reconcileActive.
  activate(app) {
    return this.#exclusive(() => {
      const request = this.state.deployments[this.state.apps[app]?.active];
      if (!request || request.step !== 'complete') throw new Error('Active publication requires a completed approval');
      return this.#publish('active', app, approval(this.state, app, request.id, request.digest, ['active']));
    });
  }
  #continuedIntent(journal, pending) {
    if (!journal.settled || BigInt(pending.record.revision) <= BigInt(journal.settled.revision) ||
      routeRecordDigest(pending.previous, this.policy) !== journal.settled.digest || pending.previous.revision !== journal.settled.revision) throw failure();
    switch (pending.kind) {
      case 'withdraw': return this.#withdrawalIntent(journal, pending);
      case 'withhold': return this.#withholdIntent(pending);
      case 'active': return this.#activeIntent(journal, pending);
      case 'release-claim': return this.#releaseIntent(pending);
      case 'quarantine': return this.#quarantineIntent(pending);
      default: throw failure();
    }
  }
  #withholdIntent(pending) {
    const target = pending.record.routes.find(route => route.host === `${pending.app}.${this.domain}`);
    if (target?.state !== 'withheld' || target.slot !== this.state.apps[pending.app]?.slot || encodeRouteRecord(this.#replaceRoute(pending.record.revision, pending.previous, target), this.policy) !== encodeRouteRecord(pending.record, this.policy)) throw failure();
  }
  #activeIntent(journal, pending) {
    const prior = pending.previous.routes.find(route => route.host === `${pending.app}.${this.domain}`);
    const held = routeHold(journal.holds, pending.app), target = pending.record.routes.find(route => route.host === `${pending.app}.${this.domain}`);
    if (!held || held.id !== pending.approval?.id || held.digest !== pending.approval.digest || prior?.state !== 'withheld' ||
      target?.state !== 'active' || target.submission !== held.id || target.digest !== held.digest || target.slot !== prior.slot) throw failure();
    if (encodeRouteRecord(this.#replaceRoute(pending.record.revision, pending.previous, target), this.policy) !== encodeRouteRecord(pending.record, this.policy)) throw failure();
  }
  #claim(app, selected) {
    approval(this.state, app, selected.id, selected.digest, ['failed']);
    const value = this.state.apps[app], request = this.state.deployments[selected.id];
    if (!value || value.active !== null || value.uncertain !== null || value.route !== 'paused' || value.migrations?.length !== 0 ||
      value.claim?.deployment !== selected.id || value.claim.digest !== selected.digest || request.step !== 'preparing-activation') throw new Error('Route removal requires a pristine failed ownership claim');
  }
  #withoutHost(revision, previous, app) {
    return { ...previous, revision, routes: previous.routes.filter(route => route.host !== `${app}.${this.domain}`) };
  }
  #releaseIntent(pending) {
    this.#claim(pending.app, pending.approval);
    this.#requireHold(pending.app, pending.approval, pending.previous);
    if (encodeRouteRecord(this.#withoutHost(pending.record.revision, pending.previous, pending.app), this.policy) !== encodeRouteRecord(pending.record, this.policy)) throw failure();
  }
  releaseClaim(app, id, digest) {
    return this.#exclusive(async () => {
      this.assertReady(); const selected = { id, digest }; this.#claim(app, selected);
      const previous = (await this.#current()).record;
      if (!previous.routes.some(route => route.host === `${app}.${this.domain}`)) {
        if (routeHold(this.#journal().holds, app)) throw failure();
        return;
      }
      this.#requireHold(app, selected, previous);
      const revision = String(BigInt(previous.revision) + 1n), record = this.#withoutHost(revision, previous, app);
      await this.#commitPending({ id: `release-claim:${revision}`, kind: 'release-claim', app, approval: selected, previous, record, digest: routeRecordDigest(record, this.policy) });
    });
  }
  #quarantineRecord(revision, previous, host) {
    const route = previous.routes.find(value => value.host === host);
    if (!route) throw new Error('Public route is unavailable');
    return this.#replaceRoute(revision, previous, { host, state: 'withheld', slot: route.slot });
  }
  #quarantineIntent(pending) {
    if (pending.app !== null || pending.approval !== null || encodeRouteRecord(this.#quarantineRecord(pending.record.revision, pending.previous, pending.host), this.policy) !== encodeRouteRecord(pending.record, this.policy)) throw failure();
  }
  withholdHost(host) {
    return this.#exclusive(async () => {
      this.assertReady(); const previous = (await this.#current()).record;
      const route = previous.routes.find(value => value.host === host);
      if (!route) throw new Error('Public route is unavailable');
      if (route.state === 'withheld') return;
      const revision = String(BigInt(previous.revision) + 1n), record = this.#quarantineRecord(revision, previous, host);
      await this.#commitPending({ id: `quarantine:${revision}`, kind: 'quarantine', app: null, approval: null, host, previous, record, digest: routeRecordDigest(record, this.policy) });
    });
  }
  #replaceRoute(revision, previous, route) {
    return { ...previous, revision, routes: [...previous.routes.filter(value => value.host !== route.host), route].sort((a, b) => a.host < b.host ? -1 : a.host > b.host ? 1 : 0) };
  }
  #withholding(revision, previous, app, selected) {
    if (selected === null) return this.#withheldRecord(revision, previous, app);
    const route = projectedRoute(app, { ...this.state.apps[app], route: 'paused' }, this.state, this.domain);
    return this.#replaceRoute(revision, previous, route);
  }
  #withheldRecord(revision, previous, app) {
    const prior = previous.routes.find(route => route.host === `${app}.${this.domain}`);
    if (!prior) throw new Error('Application has no published HTTP route');
    if (prior.slot !== this.state.apps[app]?.slot) throw failure();
    return this.#replaceRoute(revision, previous, { host: prior.host, state: 'withheld', slot: prior.slot });
  }
  #withdrawalIntent(journal, pending) {
    const prior = pending.superseded;
    if (!keys(prior, ['record', 'digest', 'approval']) || routeRecordDigest(prior.record, this.policy) !== prior.digest ||
      BigInt(prior.record.revision) <= BigInt(journal.settled.revision) || BigInt(pending.record.revision) <= BigInt(prior.record.revision)) throw failure();
    this.#continuedIntent(journal, { ...prior, kind: 'active', app: pending.app, previous: pending.previous });
    if (pending.approval !== null || encodeRouteRecord(this.#quarantineRecord(pending.record.revision, pending.previous, `${pending.app}.${this.domain}`), this.policy) !== encodeRouteRecord(pending.record, this.policy)) throw failure();
  }
  #pending(kind) {
    const journal = this.#journal(), pending = journal.pending;
    if (!pending || !kind.includes(pending.kind) || !object(pending.record) || pending.id !== `${pending.kind}:${pending.record.revision}` || routeRecordDigest(pending.record, this.policy) !== pending.digest) throw failure();
    if (pending.kind === 'initialize') {
      if (journal.settled || pending.record.revision !== '0' || pending.record.routes.length || Object.keys(journal.holds).length || Object.keys(this.state.apps).length || Object.keys(this.state.deployments).length) throw failure();
    } else this.#continuedIntent(journal, pending);
    return pending;
  }
  #currentDecision(pending) {
    if (encodeRouteRecord(this.#record(pending.record.revision, pending.previous, pending.app), this.policy) !== encodeRouteRecord(pending.record, this.policy)) throw failure();
    approval(this.state, pending.app, pending.approval.id, pending.approval.digest, ['active']);
  }
  withholdPendingActive({ intent, id, digest }) {
    return this.#exclusive(async () => {
      const previous = this.#pending(['active']);
      if (previous.id !== intent || previous.approval.id !== id || previous.approval.digest !== digest) throw new Error('Inspect and select the exact pending route publication');
      await this.#current();
      const revision = String(BigInt(previous.record.revision) + 1n), record = this.#quarantineRecord(revision, previous.previous, `${previous.app}.${this.domain}`);
      const pending = { id: `withdraw:${revision}`, kind: 'withdraw', app: previous.app, approval: null, previous: previous.previous,
        record, digest: routeRecordDigest(record, this.policy), superseded: { record: previous.record, digest: previous.digest, approval: previous.approval } };
      if (this.state.apps[previous.app]) this.state.apps[previous.app].route = 'paused';
      await this.#commitPending(pending);
    });
  }
  resumeWithholding() {
    return this.#exclusive(async () => {
      const pending = this.#pending(['initialize', 'withhold', 'withdraw', 'release-claim', 'quarantine']);
      const observed = await this.#current();
      if (!same(reference(observed), { revision: pending.record.revision, digest: pending.digest })) {
        await this.#writePending(pending, pending.kind === 'initialize');
      }
      await this.#settle(pending);
    });
  }
  // Verification is read-only and must not call queued publication methods.
  // The owner serializes backend work; re-entering this queue would deadlock.
  async #verifyRuntime(app, selected, verifyRuntime) {
    try { await verifyRuntime(app, { ...selected }); }
    catch (cause) { throw new Error('Route publication remains uncertain because runtime identity/readiness is unconfirmed', { cause }); }
  }
  resume(app, selected, verifyRuntime) {
    return this.#exclusive(async () => {
      this.assertReady();
      const decision = approval(this.state, app, selected.id, selected.digest, ['active']);
      if (typeof verifyRuntime !== 'function' || projectedRoute(app, { ...this.state.apps[app], route: 'active' }, this.state, this.domain).state !== 'active') throw new Error('Application controls withhold HTTP routing');
      const observed = await this.#current(), route = observed.record.routes.find(value => value.host === `${app}.${this.domain}`);
      if (route?.state !== 'withheld') throw new Error('HTTP route is not paused');
      this.state.apps[app].route = 'paused';
      await this.#publish('withhold', app, decision);
      await this.#verifyRuntime(app, decision, verifyRuntime);
      this.state.apps[app].route = 'active';
      await this.#publish('active', app, decision);
    });
  }
  reconcileActive({ intent, id, digest }, verifyRuntime) {
    return this.#exclusive(async () => {
      const pending = this.#pending(['active']);
      if (pending.id !== intent || pending.approval.id !== id || pending.approval.digest !== digest || typeof verifyRuntime !== 'function') throw new Error('Inspect and select the exact pending route publication');
      this.#currentDecision(pending);
      const observed = await this.#current();
      await this.#verifyRuntime(pending.app, pending.approval, verifyRuntime);
      if (!same(reference(observed), { revision: pending.record.revision, digest: pending.digest })) await this.#writePending(pending);
      await this.#settle(pending);
    });
  }
}
