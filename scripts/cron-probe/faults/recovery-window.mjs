import assert from 'node:assert/strict';

// Observer allowance for the tiny private fleet's GC, activation and reads.
// This is empirical; the native per-handler deadline does not bound a wake scan.
const observationAllowanceMs = 20000;
export function ownerRecoveryWindow({ bucket, owner, survivor, killedAt, retryDue, defaults }) {
  assert.equal(defaults.wakerTickMs, 60000); assert.equal(defaults.wakerLeaseTtlMs, 180000); assert.equal(defaults.nodeLeaseTtlMs, 10000);
  for (const time of [killedAt, retryDue, bucket.at]) assert.ok(Number.isSafeInteger(time) && time > 0);
  assert.ok(bucket.at >= killedAt, 'Post-kill observation predates the cut');
  assert.ok(killedAt < retryDue, 'Cut must precede the persisted retry deadline');
  assert.ok(bucket.waker && [owner, survivor].includes(bucket.waker.node), 'Qualification requires a known post-kill waker role');
  const roleExpiry = bucket.waker.expires_ms, lease = bucket.leases.find(row => row.host === owner);
  assert.ok(lease && !lease.missing && lease.node === owner, 'Qualification requires the killed node lease before GC');
  for (const time of [roleExpiry, lease.expires_ms]) assert.ok(Number.isSafeInteger(time) && time >= 0, 'Lease expiry must be a safe nonnegative timestamp');
  if (bucket.waker.node === owner) assert.ok(roleExpiry <= killedAt + defaults.wakerLeaseTtlMs, 'Killed waker expiry exceeds the native TTL');
  else assert.ok(roleExpiry <= bucket.at + defaults.wakerLeaseTtlMs, 'Survivor waker expiry exceeds the native TTL');
  assert.ok(lease.expires_ms <= killedAt + defaults.nodeLeaseTtlMs, 'Killed node expiry exceeds the native TTL');
  const roleHeldByKilledNode = bucket.waker.node === owner;
  const eligibleAt = Math.max(killedAt, roleHeldByKilledNode ? roleExpiry : killedAt, lease.expires_ms, retryDue);
  const deadline = eligibleAt + defaults.wakerTickMs + observationAllowanceMs;
  const ceiling = killedAt + defaults.wakerLeaseTtlMs + defaults.wakerTickMs + observationAllowanceMs;
  assert.ok(deadline <= ceiling, 'Owner recovery observation exceeds its fixed native-election ceiling');
  return { roleHeldByKilledNode, roleExpiry, nodeLeaseExpiry: lease.expires_ms, retryDue, eligibleAt, deadline, ceiling, tickMs: defaults.wakerTickMs, roleTtlMs: defaults.wakerLeaseTtlMs, observationAllowanceMs };
}
export function survivorRoleObservation(window, bucket, survivor) {
  assert.ok(bucket.waker && bucket.waker.node === survivor, 'Survivor must hold the advisory waker role');
  const at = bucket.waker.expires_ms - window.roleTtlMs;
  assert.ok(Number.isSafeInteger(at) && at > 0 && at <= bucket.at);
  if (window.roleHeldByKilledNode) {
    assert.ok(at >= window.roleExpiry, 'Survivor claimed the role before its recorded expiry');
    assert.ok(at <= window.roleExpiry + window.tickMs + window.observationAllowanceMs, 'Survivor claim exceeded the measured election window');
  }
  // Both native maintenance loops can renew after the first claim. This write
  // is an upper bound on that claim, not its exact time.
  return { claimNotBefore: window.roleHeldByKilledNode ? window.roleExpiry : null, claimNoLaterThan: at, leaseWrittenAt: at, observedAt: bucket.at };
}

export function ownerRoleTrail(window, observations, owner, survivor) {
  const first = observations.findIndex(row => row.bucket.waker?.node === survivor);
  assert.ok(first > 0, 'Survivor role observation requires a preceding killed-owner sample');
  for (const [index, row] of observations.entries()) {
    assert.ok(row.bucket.waker && [owner, survivor].includes(row.bucket.waker.node), 'Unknown role in owner recovery trail');
    if (index < first) assert.equal(row.bucket.waker.expires_ms, window.roleExpiry, 'Killed owner role changed after the post-kill read');
    else assert.equal(row.bucket.waker.node, survivor, 'Waker role returned to the killed node');
  }
  const previous = observations[first - 1], sample = observations[first];
  assert.equal(previous.bucket.waker.node, owner);
  const transfer = survivorRoleObservation(window, sample.bucket, survivor);
  assert.ok(sample.bucket.at - transfer.leaseWrittenAt < window.tickMs, 'First survivor sample missed the claiming tick');
  assert.ok(Number.isSafeInteger(previous.startedAt) && previous.startedAt > 0 && previous.startedAt <= transfer.leaseWrittenAt);
  return { ...transfer, claimNotBefore: Math.max(window.roleExpiry, previous.startedAt), lastKilledRoleSampleStartedAt: previous.startedAt };
}
