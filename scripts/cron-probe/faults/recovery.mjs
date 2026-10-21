import assert from 'node:assert/strict';
import { expect } from '../../guestbook-browser.mjs';
import { vmNow } from '../vm-time.mjs';
import { ownerRecoveryWindow, ownerRoleTrail } from './recovery-window.mjs';

export async function observeOwnerRecovery({ probe, defaults, evidence, time, rowsBefore, retry, owner, survivor, killedAt, before }) {
  const observations = []; evidence.ownerLossRecovery = { observations };
  async function observe() {
    const record = {}; observations.push(record);
    try { record.requestedAt = await vmNow(probe); Object.assign(record, await probe.ownerRecovery(time)); return record; }
    catch (error) { record.error = { name: error.name, message: error.message }; throw error; }
  }
  const postKill = await observe(); evidence.ownerLossRecovery.postKill = postKill;
  assert.ok(postKill.bucket.wakes.some(row => row.key === retry.key && row.due_ms === retry.due_ms), 'The persisted retry entry must survive the owner cut');
  const window = ownerRecoveryWindow({ bucket: postKill.bucket, owner, survivor, killedAt, retryDue: retry.due_ms, defaults });
  evidence.ownerLossRecovery.window = window;
  assert.equal(window.roleHeldByKilledNode, true, 'This profile must exercise a killed owner holding the advisory waker role');
  if (before.waker?.node === owner) assert.ok(window.roleExpiry >= before.waker.expires_ms, 'Post-kill role expiry must retain any pre-kill renewal');
  const ids = new Set(rowsBefore.map(row => row.id));
  let snapshot = postKill, fresh;
  const remaining = window.ceiling - await vmNow(probe); assert.ok(remaining > 0);
  await expect.poll(async () => {
    snapshot = await observe();
    fresh = snapshot.rows?.filter(row => !ids.has(row.id));
    return snapshot.bucket.waker?.node === survivor && snapshot.bucket.owner.node === survivor && ['advisory', 'inventory'].every(job => fresh?.some(row => row.job === job && row.scheduled_time === time && row.outcome === 'success'));
  }, { timeout: remaining + 5000, intervals: [200, 500] }).toBe(true);
  const roleTransfer = ownerRoleTrail(window, observations, owner, survivor);
  const completed = fresh.filter(row => row.scheduled_time === time && row.outcome === 'success');
  assert.ok(completed.every(row => Number.isSafeInteger(row.finished_at) && row.finished_at <= window.deadline), 'Owner recovery exceeded the measured VM-time window');
  assert.ok(fresh.every(row => row.entered_at >= Math.max(retry.due_ms, roleTransfer.claimNotBefore) && row.entered_at <= window.deadline));
  evidence.ownerLossRecovery.roleTransfer = roleTransfer;
  return { phaseAfter: snapshot.rows, fresh, bucket: snapshot.bucket, window, roleTransfer };
}
