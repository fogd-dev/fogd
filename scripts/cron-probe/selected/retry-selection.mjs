import assert from 'node:assert/strict';
import { rows } from './recovery-ledger.mjs';

function expired() {
  throw Object.assign(new Error('Selected retry occurrence or snapshot margin expired; refuse reselection'), { code: 'FOGD_SELECTION_EXPIRED' });
}

export function selectedRetry(observed, scheduledTime, at = observed.cronRecords.at) {
  assert.ok(Number.isSafeInteger(scheduledTime) && scheduledTime >= 0); assert.ok(Number.isSafeInteger(at) && at >= observed.cronRecords.at);
  const attempts = rows(observed, 'cron_fault_attempts').filter(row => row.phase === 'retry-b');
  if (attempts.some(row => row.scheduled_time > scheduledTime)) expired();
  const selected = attempts.filter(row => row.scheduled_time === scheduledTime);
  if (at >= scheduledTime + 60000) expired();
  const failures = selected.filter(row => row.job === 'advisory' && row.outcome === 'thrown').length;
  if (failures > 3) expired();
  if (selected.some(row => row.outcome === 'pending') || failures < 3) return false;
  const wake = observed.cronRecords.wakes.find(row => row.due_ms === observed.status.nextAlarm && row.due_ms > scheduledTime && row.due_ms < scheduledTime + 60000);
  if (wake && wake.due_ms <= at + 10000) expired();
  return wake && { observed, wake, scheduledTime, selectedAt: at };
}
