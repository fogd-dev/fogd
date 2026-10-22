import assert from 'node:assert/strict';
import { replicasQuiescent, assertResidentCron } from './failure-runtime-state.mjs';
import { assertRetryControl } from './failure-retry.mjs';

export function selectedOwnerRetry(snapshot, time, version, expectedWaker = null) {
  if (snapshot.ledgerError || snapshot.infoError || snapshot.ownerStateError || snapshot.ineligible) return null;
  const rows = snapshot.selected, advisory = rows.filter(row => row.job === 'advisory');
  assert.ok(advisory.length <= 2, 'Pre-cut observation missed the original retry window');
  if (advisory.length !== 2 || advisory.some(row => row.outcome !== 'thrown') || rows.some(row => row.outcome === 'pending') || rows.filter(row => row.job === 'inventory' && row.outcome === 'success').length < 2) return null;
  assert.ok(rows.every(row => row.scheduled_time === time && row.cron === '* * * * *' && row.no_retry_called === 0));
  if (!replicasQuiescent(snapshot.replicas)) return null;
  assertResidentCron(snapshot.replicas, snapshot.bucket.owner.node, version);
  assert.equal(snapshot.info.paused, false);
  const retry = snapshot.bucket.wakes.find(row => row.due_ms === snapshot.info.nextAlarm && row.due_ms < time + 60000 && row.due_ms > snapshot.completedAt + 3000);
  assert.ok(retry, 'Pre-cut observation missed the persisted retry deadline');
  assert.equal(snapshot.bucket.waker?.node, snapshot.bucket.owner.node);
  if (expectedWaker !== null) assert.equal(snapshot.bucket.waker.node, expectedWaker, 'Cut must target the staged waker');
  assert.ok(snapshot.bucket.waker.expires_ms > snapshot.completedAt);
  assert.equal(snapshot.ownerState.version, version); assert.equal(snapshot.ownerState.cells['.cron:refresh'], snapshot.ownerState.generation);
  return retry;
}
export function assertStoppedLease(bucket, node, expires) {
  const leases = bucket.leases.filter(row => row.expectedNode === node); assert.equal(leases.length, 1);
  const lease = leases[0];
  if (!lease.missing) assert.ok(lease.node === node && lease.expires_ms <= expires, 'Stopped node lease renewed after its post-cut snapshot');
}
export function assertRecoveredOwner(snapshot, before, survivor, time, retryDue, window, roleTransfer) {
  assert.equal(snapshot.bucket.owner.node, survivor); assert.ok(snapshot.bucket.owner.epoch > before.bucket.owner.epoch);
  const ids = new Set(before.rows.map(row => row.id)), added = snapshot.rows.filter(row => !ids.has(row.id)), fresh = added.filter(row => row.scheduled_time === time);
  assert.ok(added.every(row => row.scheduled_time >= time && row.entered_at >= row.scheduled_time));
  assertRetryControl(snapshot.rows.filter(row => row.scheduled_time === time), time);
  assert.deepEqual(fresh.map(row => [row.job, row.outcome]).sort(), [['advisory', 'success'], ['inventory', 'success']]);
  assert.ok(fresh.every(row => row.cron === '* * * * *' && row.entered_at >= Math.max(retryDue, roleTransfer.claimNotBefore) && row.entered_at <= window.deadline));
  assert.ok(fresh.every(row => Number.isSafeInteger(row.finished_at) && row.finished_at <= window.deadline));
  const oldInstances = new Set(before.rows.map(row => row.instance));
  assert.ok(!snapshot.rows.some(row => row.job === 'advisory' && row.outcome === 'success' && oldInstances.has(row.instance)));
  return fresh;
}
