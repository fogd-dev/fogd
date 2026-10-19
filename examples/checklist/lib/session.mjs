import { parseOperation, validId } from './input.mjs';
import { ServerMessage } from './wire.mjs';

export class ChecklistSession {
  constructor(storage, room, send, changed) {
    if (!validId(room)) throw new Error('Invalid room');
    this.storage = storage; this.send = send; this.changed = changed;
    this.prefix = `fogd-checklist:${room}:`;
    this.ready = false; this.fresh = true; this.blocked = false; this.sent = new Set();
    this.view = { status: 'Connecting', revision: 0, items: [], pending: 0, error: '', canAcceptRestored: false };
    this.watermark = this.readWatermark(); this.connectionFloor = this.watermark; this.order = 0;
    this.refreshPending();
  }
  readWatermark() {
    const raw = this.storage.getItem(this.prefix + 'revision');
    const value = raw === null ? 0 : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid saved revision');
    return value;
  }
  pending() {
    const entries = [];
    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key?.startsWith(this.prefix + 'pending:')) continue;
      const raw = this.storage.getItem(key);
      if (raw === null) continue; // Another tab may have settled it after key enumeration.
      const entry = JSON.parse(raw);
      if (!entry || !validId(entry.opId) || key !== this.pendingKey(entry.opId) || !parseOperation(entry.operation) || !Number.isSafeInteger(entry.order) || entry.order < 0) throw new Error('Invalid saved operation');
      entries.push(entry);
    }
    return entries.sort((a, b) => a.order - b.order || a.opId.localeCompare(b.opId));
  }
  pendingKey(id) { return this.prefix + 'pending:' + id; }
  notify() { this.changed({ ...this.view, items: [...this.view.items] }); }
  refreshPending() {
    const pending = this.pending(); this.view.pending = pending.length;
    this.order = Math.max(this.order, ...pending.map(entry => entry.order));
    return pending;
  }
  fail(error) {
    this.blocked = true; this.ready = false; this.view.status = 'Writes stopped';
    this.view.error = error instanceof Error ? error.message : 'Browser storage unavailable'; this.notify();
  }
  opened() {
    if (this.blocked) return;
    this.ready = false; this.fresh = true; this.sent.clear();
    this.view.status = 'Synchronizing'; this.notify();
  }
  disconnected() {
    this.ready = false;
    try { this.connectionFloor = Math.max(this.watermark, this.readWatermark()); } catch (error) { this.fail(error); return; }
    if (!this.blocked) this.view.status = 'Reconnecting';
    this.notify();
  }
  receive(raw) {
    const parsed = ServerMessage.safeParse(raw);
    if (!parsed.success || this.blocked) return;
    try {
      const message = parsed.data;
      if (message.type === 'snapshot') this.snapshot(message);
      else this.settle(message);
      this.refreshPending(); this.notify();
    } catch (error) { this.fail(error); }
  }
  snapshot(message) {
    if (!Number.isSafeInteger(message.revision) || message.revision < 0) throw new Error('Invalid server revision');
    const high = Math.max(this.watermark, this.readWatermark());
    if (this.fresh && message.revision < this.connectionFloor) {
      this.restored = message; this.view.revision = message.revision; this.view.items = message.items; this.view.canAcceptRestored = true;
      throw new Error('Server state is older than this browser observed. Review this restored board before retrying pending edits.');
    }
    if (message.revision < this.watermark) return;
    this.storage.setItem(this.prefix + 'revision', String(Math.max(high, message.revision)));
    this.watermark = message.revision; this.view.revision = message.revision; this.view.items = message.items;
    const wasFresh = this.fresh; this.fresh = false; this.ready = true; this.view.status = 'Connected';
    if (wasFresh) this.flush();
  }
  acceptRestored() {
    if (!this.restored || !this.view.canAcceptRestored) return;
    try {
      this.storage.setItem(this.prefix + 'revision', String(this.restored.revision));
      this.watermark = this.restored.revision; this.connectionFloor = this.watermark;
      this.blocked = false; this.view.error = ''; this.view.canAcceptRestored = false;
      this.sent.clear(); this.snapshot(this.restored); this.restored = null; this.notify();
    } catch (error) { this.fail(error); }
  }
  settle(message) {
    if (!validId(message.opId) || this.storage.getItem(this.pendingKey(message.opId)) === null) return;
    if (message.type === 'ack') {
      if (!Number.isSafeInteger(message.revision) || message.revision < 0) throw new Error('Invalid acknowledgment');
      const high = Math.max(this.watermark, this.readWatermark(), message.revision);
      this.storage.setItem(this.prefix + 'revision', String(high)); this.watermark = high;
    } else this.view.error = `Edit rejected: ${message.reason}`;
    this.storage.removeItem(this.pendingKey(message.opId)); this.sent.delete(message.opId);
  }
  submit(opId, value) {
    if (this.blocked) throw new Error('Writes are stopped');
    const operation = parseOperation(value);
    if (!validId(opId) || !operation) return this.refuse('Invalid edit');
    let pending;
    try { pending = this.refreshPending(); } catch (error) { this.fail(error); throw error; }
    if (pending.length >= 100) return this.refuse('Too many pending edits; reconnect before adding more');
    if (pending.some(entry => entry.opId === opId)) return this.refuse('Operation ID already pending');
    try {
      const entry = { opId, operation, order: Math.max(Date.now(), this.order + 1) };
      this.storage.setItem(this.pendingKey(opId), JSON.stringify(entry)); this.order = entry.order;
      this.view.error = ''; this.refreshPending(); this.flush(); this.notify();
    } catch (error) { this.fail(error); throw error; }
  }
  refuse(message) { this.view.error = message; this.notify(); throw new Error(message); }
  flush() {
    if (!this.ready || this.blocked) return;
    for (const entry of this.refreshPending()) {
      if (this.sent.has(entry.opId)) continue;
      try { this.send({ type: 'operation', opId: entry.opId, operation: entry.operation }); this.sent.add(entry.opId); }
      catch { this.disconnected(); return; }
    }
  }
  storageChanged() {
    if (this.blocked) return;
    try { this.refreshPending(); this.flush(); this.notify(); } catch (error) { this.fail(error); }
  }
}
