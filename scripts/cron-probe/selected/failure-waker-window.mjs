import assert from 'node:assert/strict';

export function preparationWindow(bucket, owner, peer, stoppedAt, defaults) {
  assert.equal(defaults.wakerTickMs, 60000); assert.equal(defaults.wakerLeaseTtlMs, 180000);
  assert.ok(Number.isSafeInteger(stoppedAt) && stoppedAt > 0 && bucket.at >= stoppedAt);
  const role = bucket.waker;
  if (role) {
    assert.ok([owner, peer].includes(role.node));
    if (role.node === owner) assert.ok(role.expires_ms > bucket.at, 'Live cron owner has an expired waker role');
    assert.ok(Number.isSafeInteger(role.expires_ms) && role.expires_ms >= 0 && role.expires_ms <= (role.node === peer ? stoppedAt : bucket.at) + defaults.wakerLeaseTtlMs);
  }
  const eligibleAt = role?.node === peer ? Math.max(stoppedAt, role.expires_ms) : stoppedAt;
  const deadline = eligibleAt + defaults.wakerTickMs + 20000, ceiling = stoppedAt + defaults.wakerLeaseTtlMs + defaults.wakerTickMs + 20000;
  assert.ok(deadline <= ceiling);
  return { eligibleAt, deadline, ceiling, allowanceMs: 20000, initialRole: role };
}
