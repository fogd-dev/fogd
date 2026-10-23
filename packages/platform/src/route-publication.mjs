import { encodeRouteRecord, isRouteRevision } from '@fogd/runtime/route-record';
import { readRouteRecord, routeRecordDigest, writeRouteRecord, createRouteRecord } from './route-record-store.mjs';

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
  return keys(value, fields) && ['initialize', 'withhold', 'active', 'withdraw'].includes(value.kind) && typeof value.id === 'string' && object(value.record) && hash(value.digest) &&
    (value.approval === null || approvedReference(value.approval));
}
const validReference = value => keys(value, ['revision', 'digest']) && isRouteRevision(value.revision) && hash(value.digest);
const failure = () => new Error('Route publication is uncertain; reload durable state and reconcile before changing the backend');
const same = (left, right) => Boolean(left && right && left.revision === right.revision && left.digest === right.digest);
const reference = observed => observed && ({ revision: observed.record.revision, digest: observed.digest });
function approval(state, app, id, digest, statuses) {
  const request = state.deployments[id];
  if (!request || request.app !== app || request.id !== id || request.digest !== digest || !statuses.includes(request.status) || !uuid(request.id) || !pinnedSecret(request)) throw new Error('Route publication requires the exact pinned approval');
  if (request.status === 'active' && (state.apps[app]?.active !== id || request.step !== 'complete')) throw new Error('Route publication requires the current completed approval');
  return { id, digest };
}
function withheldApplication(app) {
  const holds = [app.quarantined, app.uncertain, app.claim, app.delivery?.hold, app.dispatch?.hold];
  const recovering = [app.queueRecovery, app.cronRecovery].some(record => record && record.status !== 'acknowledged');
  return app.route !== 'active' || holds.some(Boolean) || recovering;
}
function projectedRoute(name, app, state, domain) {
  if (!object(app)) throw new Error('Route application is unavailable');
  if (app.retirement) throw new Error('Retired apps cannot publish live route authority');
  const route = { host: `${name}.${domain}`, state: 'withheld', slot: app.slot };
  if (withheldApplication(app)) return route;
  const request = state.deployments[app.active];
  if (!request || request.app !== name || request.id !== app.active || request.status !== 'active' || request.step !== 'complete' || !pinnedSecret(request)) throw new Error('Active route has no completed pinned approval');
  return { ...route, state: 'active', submission: request.id, digest: request.digest };
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
    try { return await task(); } catch (cause) { this.#failed = true; throw new Error(failure().message, { cause }); }
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
    if (pending.kind === 'active') delete holds[pending.app];
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
    this.state.routeAuthority.pending = pending;
    await this.#durable(() => this.savePrivate());
    await this.#writePending(pending);
    await this.#settle(pending);
  }
  #requireHold(app, selected, record) {
    const held = this.#journal().holds[app], route = record.routes.find(value => value.host === `${app}.${this.domain}`);
    if (held?.id !== selected.id || held.digest !== selected.digest || route?.state !== 'withheld' || route.slot !== this.state.apps[app]?.slot) throw new Error('Active publication requires withholding for the exact approval');
  }
  assertWithheld(app, id, digest) {
    return this.#exclusive(async () => {
      this.assertReady();
      const selected = approval(this.state, app, id, digest, ['activating', 'failed', 'active']);
      this.#requireHold(app, selected, (await this.#current()).record);
    });
  }
  #selectHold(app, selected, replaces) {
    const held = this.#journal().holds[app];
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
    if (pending.kind === 'withdraw') return this.#withdrawalIntent(journal, pending);
    if (pending.kind === 'withhold') {
      const target = pending.record.routes.find(route => route.host === `${pending.app}.${this.domain}`);
      if (target?.state !== 'withheld' || target.slot !== this.state.apps[pending.app]?.slot || encodeRouteRecord(this.#replaceRoute(pending.record.revision, pending.previous, target), this.policy) !== encodeRouteRecord(pending.record, this.policy)) throw failure();
    }
    const prior = pending.previous.routes.find(route => route.host === `${pending.app}.${this.domain}`);
    if (pending.kind === 'active') {
      const held = journal.holds[pending.app], target = pending.record.routes.find(route => route.host === `${pending.app}.${this.domain}`);
      if (!held || held.id !== pending.approval?.id || held.digest !== pending.approval.digest || prior?.state !== 'withheld' ||
        target?.state !== 'active' || target.submission !== held.id || target.digest !== held.digest || target.slot !== prior.slot) throw failure();
      if (encodeRouteRecord(this.#replaceRoute(pending.record.revision, pending.previous, target), this.policy) !== encodeRouteRecord(pending.record, this.policy)) throw failure();
    }
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
    if (pending.approval !== null || encodeRouteRecord(this.#withheldRecord(pending.record.revision, pending.previous, pending.app), this.policy) !== encodeRouteRecord(pending.record, this.policy)) throw failure();
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
      const revision = String(BigInt(previous.record.revision) + 1n), record = this.#withheldRecord(revision, previous.previous, previous.app);
      const pending = { id: `withdraw:${revision}`, kind: 'withdraw', app: previous.app, approval: null, previous: previous.previous,
        record, digest: routeRecordDigest(record, this.policy), superseded: { record: previous.record, digest: previous.digest, approval: previous.approval } };
      if (this.state.apps[previous.app]) this.state.apps[previous.app].route = 'paused';
      this.state.routeAuthority.pending = pending;
      await this.#durable(() => this.savePrivate()); await this.#writePending(pending); await this.#settle(pending);
    });
  }
  resumeWithholding() {
    return this.#exclusive(async () => {
      const pending = this.#pending(['initialize', 'withhold', 'withdraw']);
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
