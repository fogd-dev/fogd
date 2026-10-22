import assert from 'node:assert/strict';

// A journal of the runner's explicit requests, not a network packet trace.
export class FailureAccess {
  #quiet = false;
  constructor(clockNode, clock = Date.now) { this.clockNode = clockNode; this.clock = clock; this.events = []; }
  record(event) {
    const permitted = !this.#quiet || event.kind === 'bucket-only' || event.kind === 'inspect' || event.kind === 'replica-start' || (event.kind === 'clock' && event.node === this.clockNode);
    this.events.push({ ...event, quiet: this.#quiet, hostAt: this.clock(), ...(!permitted ? { refused: true } : {}) });
    if (permitted) return;
    const error = new Error('Native access is forbidden during the quiet window'); error.code = 'FOGD_QUIET_WINDOW'; throw error;
  }
  beginQuiet(at) {
    assert.equal(this.#quiet, false); assert.ok(Number.isSafeInteger(at) && at > 0);
    this.#quiet = true; this.events.push({ kind: 'quiet-begin', vmAt: at });
  }
  endQuiet(at) {
    assert.equal(this.#quiet, true); assert.ok(Number.isSafeInteger(at) && at > 0);
    this.#quiet = false; this.events.push({ kind: 'quiet-end', vmAt: at });
  }
  install(host) {
    host.access = event => this.record(event);
    for (const name of ['command', 'json']) {
      const original = host[name];
      host[name] = (args, options) => { this.record({ kind: 'cli', command: args.slice(0, 4) }); return original(args, options); };
    }
  }
}
