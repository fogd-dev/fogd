import assert from 'node:assert/strict';
import { rows } from './recovery-ledger.mjs';

export function assertFreshCron(observed) {
  assert.equal(observed.status.paused, true); assert.equal(observed.status.nextAlarm, null); assert.deepEqual(observed.cronRecords.wakes, []);
  assert.equal(observed.databases.length, 1);
  for (const table of ['cron_fault_attempts', 'refresh_occurrences', 'refresh_results']) {
    assert.ok(Object.hasOwn(observed.databases[0].data, table)); assert.deepEqual(rows(observed, table), []);
  }
  assert.deepEqual(rows(observed, 'refresh_settings'), [{ id: 1, mode: 'retry-once' }]);
  assert.deepEqual(rows(observed, 'cron_fault_control'), [{ id: 1, policy: 'healthy', phase: 'startup' }]);
}
