// Durable dispatch intent shared by queue delivery and experimental cron controls.
// Constructing a journal never performs a runtime operation.
export class DispatchControl {
  #state;
  #busy = false;
  #reload = false;
  #persist;
  #runtime;
  #slot;
  #contract;
  #clock;
  constructor({ state, persist, runtime, slot, contract, clock = Date.now }) {
    contract.validate(state);
    this.#contract = contract; this.#clock = clock;
    this.#state = structuredClone(state);
    this.#persist = persist; this.#runtime = runtime; this.#slot = slot;
  }
  get state() { this.#usable(); return structuredClone(this.#state); }
  get effective() { return effectiveDispatch(this.state); }
  get confirmed() { const state = this.state; return state.operation === null && state.observed === effectiveDispatch(state); }
  #usable() { if (this.#reload) throw new Error(`${this.#contract.title} persistence failed; reload the journal before continuing`); }
  async #exclusive(task) {
    this.#usable();
    if (this.#busy) throw new Error(`${this.#contract.title} operation already in progress`);
    this.#busy = true;
    try { return await task(); } finally { this.#busy = false; }
  }
  async #save(state) {
    this.#contract.validate(state);
    try { await this.#persist(structuredClone(state)); }
    catch (error) { this.#reload = true; throw error; }
    this.#state = state;
  }
  async #apply(changes = {}, releaseHold = false) {
    const next = { ...this.#state, ...changes, observed: 'unknown', observedAt: null };
    const target = releaseHold ? next.desired : effectiveDispatch(next);
    const verb = target === 'paused' ? 'pause' : 'resume';
    if (verb === 'resume' && !next.version) throw new Error('Approved runtime version required');
    const version = next.version;
    if (releaseHold) next.version = this.#state.version;
    next.operation = verb;
    // Durable intent precedes effects. A crash at any later point leaves a
    // retryable operation, never an inferred runtime observation.
    await this.#save(next);
    const status = await this.#runtime[verb](this.#slot, next[this.#contract.identity], version);
    if (status?.paused !== (verb === 'pause')) {
      const error = new Error(`Runtime did not confirm ${this.#contract.noun} state`);
      error.code = this.#contract.outcomeCode;
      throw error;
    }
    await this.#save({ ...next, version, hold: releaseHold ? null : next.hold, operation: null, observed: status.paused ? 'paused' : 'running', observedAt: new Date(this.#clock()).toISOString() });
    return this.state;
  }
  pause() { return this.#exclusive(() => this.#apply({ desired: 'paused' })); }
  resume() {
    return this.#exclusive(() => {
      if (this.#state.hold) throw new Error(`Activation hold prevents ${this.#contract.noun} resume`);
      return this.#apply({ desired: 'running' });
    });
  }
  hold(activation, { replaces = null } = {}) {
    return this.#exclusive(() => {
      if (typeof activation !== 'string' || !activation) throw new Error('Activation identifier required');
      if (replaces !== null && this.#state.hold !== replaces) throw new Error(`Replaced activation does not own the ${this.#contract.noun} hold`);
      if (this.#state.hold && this.#state.hold !== activation && replaces !== this.#state.hold) throw new Error(`Another activation owns the ${this.#contract.noun} hold`);
      return this.#apply({ hold: activation });
    });
  }
  // Only the activation coordinator may call this after migration/publication
  // readiness. Runtime.resume independently checks the approved generation.
  completeActivation(activation, version) {
    return this.#exclusive(() => {
      if (!activation || this.#state.hold !== activation) throw new Error(`Activation does not own the ${this.#contract.noun} hold`);
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
      const status = await this.#runtime.status(this.#slot, this.#state[this.#contract.identity]);
      if (typeof status?.paused !== 'boolean') throw new Error(`Invalid runtime ${this.#contract.noun} observation`);
      await this.#save({ ...this.#state, observed: status.paused ? 'paused' : 'running', observedAt: new Date(this.#clock()).toISOString() });
      return this.state;
    });
  }
}


export function initialControl(subject, activation, contract) {
  const state = { schema: 1, [contract.identity]: subject, desired: 'running', hold: activation, version: null, observed: 'unknown', observedAt: null, operation: null };
  if (!activation) throw new Error(`Initial ${contract.noun} requires an activation hold`);
  contract.validate(state);
  return state;
}

const journalFields = new Set(['schema', 'desired', 'hold', 'version', 'observed', 'observedAt', 'operation']);
export function validateControl(state, { identity, pattern, noun, title }) {
  validateIdentity(state, identity, pattern, noun);
  if (!['paused', 'running'].includes(state.desired) || !['unknown', 'paused', 'running'].includes(state.observed) || ![null, 'pause', 'resume'].includes(state.operation)) throw new Error(`Invalid ${noun} state`);
  if (!state.hold && !state.version) throw new Error(`${title} needs an activation hold or approved version`);
  if (state.observed === 'unknown' ? state.observedAt !== null : typeof state.observedAt !== 'string' || !Number.isFinite(Date.parse(state.observedAt))) throw new Error(`Invalid ${noun} observation`);
}

function validateIdentity(state, identity, pattern, noun) {
  if (!state || state.schema !== 1 || typeof state[identity] !== 'string' || !pattern.test(state[identity])) throw new Error(`Invalid ${noun} journal`);
  if (Object.keys(state).some(key => key !== identity && !journalFields.has(key))) throw new Error(`Unknown ${noun} journal field`);
  for (const key of ['hold', 'version']) if (state[key] !== null && (typeof state[key] !== 'string' || !state[key])) throw new Error(`Invalid ${noun} identity`);
}

function effectiveDispatch(state) { return state.hold ? 'paused' : state.desired; }
