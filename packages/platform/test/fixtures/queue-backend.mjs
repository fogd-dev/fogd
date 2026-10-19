import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readJson, saveJson } from '../../src/store.mjs';
import { claimBackend } from './claim-backend.mjs';

// Persistent stand-in for runtime effects across a real controller process kill.
export function queueBackend(dir, after = () => {}) {
  const path = join(dir, 'queue-runtime.json');
  async function effect(event, changes = {}) {
    const previous = await readJson(path, { version: null, paused: false, events: [] });
    const next = { ...previous, ...changes, events: [...previous.events, event] };
    await saveJson(path, next); after(event); return next;
  }
  return { ...claimBackend(dir),
    async bootstrap() { await effect('bootstrap', { version: 'bootstrap' }); return 'bootstrap'; },
    async publish() {
      assert.equal((await readJson(path)).paused, true);
      const version = `app-${Date.now()}`;
      await effect('publish', { version }); return version;
    },
    async ready(_, version) { assert.equal((await readJson(path)).version, version); await effect('ready'); },
    async migrate() { assert.equal((await readJson(path)).paused, true); await effect('migrate'); },
    async applied() { assert.equal((await readJson(path)).paused, true); await effect('ledger'); return []; },
    queues: {
      async pause() { await effect('pause', { paused: true }); return { paused: true }; },
      async resume(_, _name, version) { assert.equal((await readJson(path)).version, version); await effect('resume', { paused: false }); return { paused: false }; },
    },
  };
}
