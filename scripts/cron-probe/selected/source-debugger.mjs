import { createHash } from 'node:crypto';

const releaseCondition = 'verb === "resume" && releaseHold === true';

// Breakpoints can read the fixed release condition; they cannot evaluate or
// replace product functions through this interface.
export class SourceDebugger {
  #transport;
  #sources;
  #verified = new Map();
  #breakpoints = new Map();
  constructor(transport, sources) { this.#transport = transport; this.#sources = structuredClone(sources); }
  async enable() {
    await this.#transport.request('Debugger.enable');
  }
  async #source(path) {
    if (this.#verified.has(path)) {
      const source = this.#verified.get(path); this.#unique(source.url); return source;
    }
    const expected = this.#sources[path];
    if (!/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('Checkpoint source is outside the checked inventory');
    const url = `file:///app/${path}`;
    const parsed = await this.#transport.event('Debugger.scriptParsed', value => value.url === url);
    const { scriptSource } = await this.#transport.request('Debugger.getScriptSource', { scriptId: parsed.scriptId });
    if (createHash('sha256').update(scriptSource).digest('hex') !== expected) throw new Error('Loaded debugger source differs from the checked image');
    this.#unique(url);
    const source = { scriptId: parsed.scriptId, url, sha256: expected, lines: scriptSource.split('\n') };
    this.#verified.set(path, source); return source;
  }
  #unique(url) {
    if (this.#transport.takeEvents('Debugger.scriptParsed', event => event.url === url).length) throw new Error('Debugger source URL was loaded more than once');
  }
  assertPaused(sequence) {
    const state = this.#transport.pauseState;
    if (!state.paused || (sequence !== undefined && state.sequence !== sequence)) throw new Error('Controller advanced beyond its paused checkpoint');
    return state.sequence;
  }
  async breakpoint({ path, marker, offset = 0, functionName, condition = '' }) {
    if (!['', releaseCondition].includes(condition) || ![0, 1].includes(offset) || !marker || !functionName) throw new Error('Unsupported immutable checkpoint');
    const source = await this.#source(path), matches = source.lines.flatMap((line, index) => line.includes(marker) ? [index] : []);
    if (matches.length !== 1) throw new Error('Checkpoint no longer uniquely identifies its source');
    const lineNumber = matches[0] + offset;
    const possible = await this.#transport.request('Debugger.getPossibleBreakpoints', {
      start: { scriptId: source.scriptId, lineNumber, columnNumber: 0 },
      end: { scriptId: source.scriptId, lineNumber: lineNumber + 1, columnNumber: 0 }, restrictToFunction: false,
    });
    const location = possible.locations.find(value => value.lineNumber === lineNumber);
    if (!location) throw new Error('Checkpoint has no executable source location');
    const result = await this.#transport.request('Debugger.setBreakpoint', { location, condition });
    if (result.actualLocation.scriptId !== source.scriptId || result.actualLocation.lineNumber !== lineNumber) throw new Error('Debugger moved the requested checkpoint');
    const checkpoint = { id: result.breakpointId, path, sha256: source.sha256, functionName, condition, location: result.actualLocation };
    this.#breakpoints.set(checkpoint.id, checkpoint); return checkpoint;
  }
  async paused(checkpoint, timeout = 180000) {
    const event = await this.#transport.event('Debugger.paused', () => true, timeout), frame = event.callFrames?.[0];
    if (!event.hitBreakpoints?.includes(checkpoint.id) || frame?.functionName !== checkpoint.functionName ||
      frame.location.scriptId !== checkpoint.location.scriptId || frame.location.lineNumber !== checkpoint.location.lineNumber ||
      frame.location.columnNumber !== checkpoint.location.columnNumber) throw new Error('Controller paused outside its expected checkpoint');
    return { checkpoint, pauseSequence: this.assertPaused(), reason: event.reason, frame: { functionName: frame.functionName, location: frame.location } };
  }
  async remove(checkpoint) {
    await this.#transport.request('Debugger.removeBreakpoint', { breakpointId: checkpoint.id });
    this.#breakpoints.delete(checkpoint.id);
  }
  async resume() { await this.#transport.request('Debugger.resume'); }
  async close() {
    for (const checkpoint of this.#breakpoints.values()) await this.remove(checkpoint);
    await this.#transport.close();
  }
}
