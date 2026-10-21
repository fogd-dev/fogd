import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class DebuggerTransport {
  #child;
  #sequence = 0;
  #pending = new Map();
  #events = [];
  #waiters = new Set();
  #failure;
  #ready;
  #paused = false;
  #pauseSequence = 0;
  #closed;
  constructor(container, source) {
    this.#child = spawn('docker', ['exec', '-i', container, '/usr/local/bin/node', '--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.#closed = new Promise(resolve => this.#child.once('close', resolve));
    this.#child.stderr.resume();
    this.#child.stdin.on('error', () => this.#fail(new Error('Debugger input closed')));
    this.#child.on('error', () => this.#fail(new Error('Debugger helper could not start')));
    this.#child.on('close', code => this.#fail(new Error(`Debugger helper exited (${code})`)));
    createInterface({ input: this.#child.stdout, crlfDelay: Infinity }).on('line', line => this.#receive(line));
  }
  #receive(line) {
    try {
      if (line.length > 2 * 1024 * 1024) throw new Error();
      const message = JSON.parse(line);
      if (message.type === 'ready') this.#ready = message;
      else if (message.value?.id) this.#reply(message.value);
      else {
        if (this.#events.length >= 4096) throw new Error();
        if (message.value?.method === 'Debugger.paused') { this.#paused = true; this.#pauseSequence++; }
        if (message.value?.method === 'Debugger.resumed') { this.#paused = false; this.#pauseSequence++; }
        this.#events.push(message.value);
      }
      for (const notify of this.#waiters) notify();
    } catch { this.#fail(new Error('Invalid or excessive debugger output')); }
  }
  #reply(value) {
    const pending = this.#pending.get(value.id);
    if (!pending) throw new Error('Unexpected debugger reply');
    this.#pending.delete(value.id);
    if (value.error) pending.reject(new Error('Debugger command refused'));
    else pending.resolve(value.result);
  }
  #fail(error) {
    this.#failure ||= error;
    for (const pending of this.#pending.values()) pending.reject(this.#failure);
    this.#pending.clear();
    for (const notify of this.#waiters) notify();
  }
  get pauseState() {
    if (this.#failure) throw this.#failure;
    return { paused: this.#paused, sequence: this.#pauseSequence };
  }
  takeEvents(method, predicate) {
    const found = this.#events.filter(event => event?.method === method && predicate(event.params));
    this.#events = this.#events.filter(event => !found.includes(event)); return found;
  }
  async ready() { return this.#wait(() => this.#ready, 15000); }
  async request(method, params = {}, timeout = 15000) {
    if (this.#failure) throw this.#failure;
    const id = ++this.#sequence;
    const result = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    const deadline = setTimeout(() => this.#fail(new Error('Debugger command timed out')), timeout);
    try { return await result; }
    finally { clearTimeout(deadline); }
  }
  async event(method, predicate = () => true, timeout = 15000) {
    return this.#wait(() => {
      const index = this.#events.findIndex(event => event?.method === method && predicate(event.params));
      return index < 0 ? null : this.#events.splice(index, 1)[0].params;
    }, timeout);
  }
  async #wait(read, timeout) {
    return new Promise((resolve, reject) => {
      let deadline;
      const notify = () => {
        const value = read();
        if (!value && !this.#failure) return;
        clearTimeout(deadline); this.#waiters.delete(notify);
        value ? resolve(value) : reject(this.#failure);
      };
      deadline = setTimeout(() => { this.#waiters.delete(notify); reject(new Error('Debugger observation timed out')); }, timeout);
      this.#waiters.add(notify); notify();
    });
  }
  async close() {
    if (!this.#failure) await this.request('Debugger.disable').catch(() => {});
    this.#child.stdin.end();
    if (!this.#child.killed) this.#child.kill('SIGTERM');
    const deadline = setTimeout(() => this.#child.kill('SIGKILL'), 1000);
    try { await this.#closed; } finally { clearTimeout(deadline); }
  }
}
