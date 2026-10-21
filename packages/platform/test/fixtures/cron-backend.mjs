import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { artifactDigest } from '@fogd/runtime/artifact';
import { readJson, saveJson } from '../../src/store.mjs';
import { claimBackend } from './claim-backend.mjs';

// Persistent runtime stand-in for integration tests, including actual SIGKILL.
// It asserts the hold at every operation that could load code or write D1.
export function cronBackend(dir, after = () => {}, before = () => {}) {
  const path = join(dir, 'cron-runtime.json');
  const read = () => readJson(path, { version: null, paused: true, revision: 0, events: [], schemaReady: false, crons: [] });
  async function effect(event, changes = {}) {
    before(event);
    const previous = await read(), next = { ...previous, ...changes, events: [...previous.events, event] };
    if (typeof changes.paused === 'boolean' && changes.paused !== previous.paused) next.revision++;
    await saveJson(path, next); after(event); return next;
  }
  const status = state => ({ paused: state.paused, revision: state.revision, nextAlarm: state.paused ? null : 60000, crons: state.crons });
  return { ...claimBackend(dir),
    hasDeployment: async () => Boolean((await read()).version),
    async bootstrap() {
      const state = await read();
      assert.ok(!state.version || state.version === 'bootstrap', 'Never replace application code with bootstrap');
      await effect('bootstrap', { version: 'bootstrap', crons: [] }); return 'bootstrap';
    },
    async publish(_, artifact) {
      const state = await read(); assert.equal(state.paused, true); assert.equal(state.schemaReady, true);
      const config = JSON.parse(await readFile(join(artifact, 'wrangler.json'), 'utf8'));
      const version = `app-${(await artifactDigest(artifact)).slice(0, 16)}`;
      await effect('publish', { version, crons: config.triggers.crons, vars: config.vars || {} }); return version;
    },
    async ready(_, version) { assert.equal((await read()).version, version); await effect('ready'); },
    async applicationReady() { assert.ok((await read()).vars.REFRESH_TOKEN); await effect('application-ready'); },
    async migrate(_, artifact, resources) {
      assert.equal((await read()).paused, true);
      const applied = [];
      for (const db of resources.d1) for (const name of await readdir(join(artifact, db.migrations_dir))) applied.push({ database: db.database_id, name });
      await effect('migrate', { schemaReady: true, applied });
    },
    async applied() { assert.equal((await read()).paused, true); const state = await effect('ledger'); return state.applied || []; },
    crons: {
      async pause() { await effect('pause', { paused: true }); return { paused: true }; },
      async resume(_, script, version) {
        assert.equal(script, 'refresh'); const state = await read();
        assert.equal(state.version, version); assert.equal(state.schemaReady, true); assert.ok(state.crons.length);
        await effect('resume', { paused: false }); return { paused: false };
      },
      async status() { return status(await read()); },
      async snapshot(_, script, version) {
        const state = await read(); assert.equal(script, 'refresh'); assert.equal(state.version, version); assert.equal(state.paused, true);
        await effect('snapshot'); return status(state);
      },
    },
  };
}
