import { ServerMessage } from './wire.mjs';

// Live events are hints. Only a post-registration room snapshot supplies state.
export class ChecklistObserver {
  constructor(read, changed, room) {
    this.room = room; this.read = read; this.changed = changed; this.epoch = 0; this.registered = false;
    this.requests = 0; this.applied = 0; this.closed = false; this.observed = false; this.floor = 0;
    this.view = { status: 'Connecting', revision: 0, items: [], error: '', restored: false };
  }
  notify() { if (!this.closed) this.changed({ ...this.view, items: [...this.view.items] }); }
  disconnected() {
    if (this.closed) return;
    this.epoch++; this.registered = false; this.observed = false; this.floor = this.view.revision;
    this.view.status = 'Reconnecting'; this.notify();
  }
  failed() {
    if (this.closed) return;
    this.epoch++; this.registered = false; this.view.status = 'Not subscribed';
    this.view.error = 'Subscription failed. Reload the board to try again.'; this.notify();
  }
  async control(response, epoch) {
    if (this.closed || epoch !== this.epoch) return;
    const result = await response.clone().json();
    if (this.closed || epoch !== this.epoch) return;
    if (!response.ok || !result.accepted || !result.results?.some(r => r.ok && r.kind === 'subscribe' && r.id === 'board' && r.topic === this.room)) {
      this.failed(); return;
    }
    this.registered = true; this.view.status = 'Synchronizing'; this.notify();
    await this.refresh();
  }
  async refresh() {
    if (this.closed || !this.registered || this.view.restored) return;
    const epoch = this.epoch, request = ++this.requests;
    try {
      const value = ServerMessage.parse(await this.read());
      if (value.type !== 'snapshot') throw new Error('Expected room snapshot');
      if (this.closed || epoch !== this.epoch || this.view.restored) return;
      if (!this.observed && value.revision < this.floor) {
        this.view.restored = true; this.view.status = 'Restored state detected';
        this.view.error = 'The board is older than this view. Reload to accept the restored state.';
      } else if (value.revision >= this.view.revision) {
        this.applied = request; this.observed = true; this.view = { ...this.view, status: 'Live', revision: value.revision, items: value.items, error: '' };
      }
      this.notify();
    } catch (error) {
      if (this.closed || epoch !== this.epoch || request < this.applied) return;
      this.view.status = 'Snapshot unavailable'; this.view.error = String(error); this.notify();
    }
  }
  hint(event) {
    if (Number.isSafeInteger(event?.data?.revision) && event.data.revision > this.view.revision) void this.refresh();
  }
  close() { this.closed = true; this.epoch++; }
}
