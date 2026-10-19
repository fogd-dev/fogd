// Internal delivery journal. The controller must serialize this with publication.
// Constructing from persisted state never performs a runtime operation.
export function initialDelivery(queue, activation) {
  const state = { schema: 1, queue, desired: 'running', hold: activation, version: null, observed: 'unknown', observedAt: null, operation: null };
  if (!activation) throw new Error('Initial delivery requires an activation hold');
  validateDelivery(state);
  return state;
}

export class Delivery {
  #state;
  #busy = false;
  #reload = false;
  #persist;
  #runtime;
  #slot;
  constructor({ state, persist, runtime, slot }) {
    validateDelivery(state);
    this.#state = structuredClone(state);
    this.#persist = persist; this.#runtime = runtime; this.#slot = slot;
  }
  get state() { this.#usable(); return structuredClone(this.#state); }
  get effective() { return effectiveDelivery(this.state); }
  get confirmed() { const state = this.state; return state.operation === null && state.observed === effectiveDelivery(state); }
  #usable() { if (this.#reload) throw new Error('Delivery persistence failed; reload the journal before continuing'); }
  async #exclusive(task) {
    this.#usable();
    if (this.#busy) throw new Error('Delivery operation already in progress');
    this.#busy = true;
    try { return await task(); } finally { this.#busy = false; }
  }
  async #save(state) {
    validateDelivery(state);
    try { await this.#persist(structuredClone(state)); }
    catch (error) { this.#reload = true; throw error; }
    this.#state = state;
  }
  async #apply(changes = {}, releaseHold = false) {
    const next = { ...this.#state, ...changes, observed: 'unknown', observedAt: null };
    const target = releaseHold ? next.desired : effectiveDelivery(next);
    const verb = target === 'paused' ? 'pause' : 'resume';
    if (verb === 'resume' && !next.version) throw new Error('Approved runtime version required');
    const version = next.version;
    if (releaseHold) next.version = this.#state.version;
    next.operation = verb;
    // Durable intent precedes effects. A crash at any later point leaves a
    // retryable operation, never an inferred runtime observation.
    await this.#save(next);
    const status = await this.#runtime[verb](this.#slot, next.queue, version);
    if (status?.paused !== (verb === 'pause')) {
      const error = new Error('Runtime did not confirm delivery state');
      error.code = 'QUEUE_OUTCOME_UNKNOWN';
      throw error;
    }
    await this.#save({ ...next, version, hold: releaseHold ? null : next.hold, operation: null, observed: status.paused ? 'paused' : 'running', observedAt: new Date().toISOString() });
    return this.state;
  }
  pause() { return this.#exclusive(() => this.#apply({ desired: 'paused' })); }
  resume() {
    return this.#exclusive(() => {
      if (this.#state.hold) throw new Error('Activation hold prevents delivery resume');
      return this.#apply({ desired: 'running' });
    });
  }
  hold(activation, { replaces = null } = {}) {
    return this.#exclusive(() => {
      if (typeof activation !== 'string' || !activation) throw new Error('Activation identifier required');
      if (replaces !== null && this.#state.hold !== replaces) throw new Error('Replaced activation does not own the delivery hold');
      if (this.#state.hold && this.#state.hold !== activation && replaces !== this.#state.hold) throw new Error('Another activation owns the delivery hold');
      return this.#apply({ hold: activation });
    });
  }
  // Only the activation coordinator may call this after migration/publication
  // readiness. Runtime.resume independently checks the approved generation.
  completeActivation(activation, version) {
    return this.#exclusive(() => {
      if (!activation || this.#state.hold !== activation) throw new Error('Activation does not own the delivery hold');
      if (typeof version !== 'string' || !version) throw new Error('Approved runtime version required');
      if (!this.confirmed) throw new Error('Activation hold is not confirmed paused');
      return this.#apply({ version }, true);
    });
  }
  reconcile() { return this.#exclusive(() => this.#apply()); }
  observe() {
    return this.#exclusive(async () => {
      // Invalidate the previous observation even if the status call fails.
      await this.#save({ ...this.#state, observed: 'unknown', observedAt: null });
      const status = await this.#runtime.status(this.#slot, this.#state.queue);
      if (typeof status?.paused !== 'boolean') throw new Error('Invalid runtime delivery observation');
      await this.#save({ ...this.#state, observed: status.paused ? 'paused' : 'running', observedAt: new Date().toISOString() });
      return this.state;
    });
  }
}

export function validateDelivery(state) {
  validateIdentity(state);
  if (!['paused', 'running'].includes(state.desired) || !['unknown', 'paused', 'running'].includes(state.observed) || ![null, 'pause', 'resume'].includes(state.operation)) throw new Error('Invalid delivery state');
  if (!state.hold && !state.version) throw new Error('Delivery needs an activation hold or approved version');
  if (state.observed === 'unknown' ? state.observedAt !== null : typeof state.observedAt !== 'string' || !Number.isFinite(Date.parse(state.observedAt))) throw new Error('Invalid delivery observation');
}

function effectiveDelivery(state) { return state.hold ? 'paused' : state.desired; }
const journalFields = new Set(['schema', 'queue', 'desired', 'hold', 'version', 'observed', 'observedAt', 'operation']);
function validateIdentity(state) {
  if (!state || state.schema !== 1 || typeof state.queue !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.:$-]*$/.test(state.queue)) throw new Error('Invalid delivery journal');
  if (Object.keys(state).some(key => !journalFields.has(key))) throw new Error('Unknown delivery journal field');
  for (const key of ['hold', 'version']) if (state[key] !== null && (typeof state[key] !== 'string' || !state[key])) throw new Error('Invalid delivery identity');
}
