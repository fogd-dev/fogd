import assert from 'node:assert/strict';
import { rows } from './recovery-ledger.mjs';

// A paused schedule update must preserve every old row and admit only new-grid work.
export function assertOfflineLedger(observed, selected, cron, previous) {
  for (const table of ['cron_fault_attempts', 'refresh_occurrences', 'refresh_results']) {
    const current = rows(observed, table), before = previous ? rows(previous, table) : [];
    const oldCrons = new Set(before.map(row => row.cron)); assert.ok(!oldCrons.has(cron));
    assert.deepEqual(current.filter(row => oldCrons.has(row.cron)), before, `${table}: old schedule rows changed`);
    const fresh = current.filter(row => !oldCrons.has(row.cron)); assert.ok(fresh.length >= 2);
    for (const row of fresh) {
      assert.equal(row.cron, cron); assert.ok(Number.isSafeInteger(row.scheduled_time));
      assert.equal(row.scheduled_time % (cron === '*/3 * * * *' ? 180000 : 60000), 0);
      assert.ok(row.scheduled_time > selected.resume.requestedAt);
      if (table === 'cron_fault_attempts') { assert.equal(row.phase, selected.phase); assert.equal(row.outcome, 'success'); }
    }
    for (const time of new Set(fresh.map(row => row.scheduled_time))) assert.deepEqual(fresh.filter(row => row.scheduled_time === time).map(row => row.job).sort(), ['advisory', 'inventory']);
  }
}
