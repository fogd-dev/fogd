import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerRecoveryWindow, survivorRoleObservation, ownerRoleTrail } from './recovery-window.mjs';

const fixture = () => ({ owner: 'a', survivor: 'b', killedAt: 1000000, retryDue: 1007500,
  defaults: { wakerTickMs: 60000, wakerLeaseTtlMs: 180000, nodeLeaseTtlMs: 10000 },
  bucket: { at: 1000100, waker: { node: 'a', expires_ms: 1170000 }, leases: [{ host: 'a', node: 'a', expires_ms: 1004000, missing: false }] } });

test('post-kill waker expiry sets the bounded election window', () => {
  assert.deepEqual(ownerRecoveryWindow(fixture()), { roleHeldByKilledNode: true, roleExpiry: 1170000, nodeLeaseExpiry: 1004000, retryDue: 1007500, eligibleAt: 1170000, deadline: 1250000, ceiling: 1260000, tickMs: 60000, roleTtlMs: 180000, observationAllowanceMs: 20000 });
});
test('a survivor already holding the role does not wait for its own role expiry', () => {
  const input = fixture(); input.bucket.waker.node = 'b';
  assert.equal(ownerRecoveryWindow(input).deadline, 1087500);
});
test('the killed node lease can be the last takeover gate', () => {
  const input = fixture(); input.bucket.waker.expires_ms = 999000; input.bucket.leases[0].expires_ms = 1009000;
  assert.equal(ownerRecoveryWindow(input).eligibleAt, 1009000);
});
test('the persisted retry deadline can be the last dispatch gate', () => {
  const input = fixture(); input.bucket.waker.expires_ms = 999000;
  assert.equal(ownerRecoveryWindow(input).eligibleAt, 1007500);
});
test('a renewal after the pre-kill observation uses the later post-kill expiry', () => {
  const input = fixture(); input.bucket.waker.expires_ms = 1180000;
  assert.equal(ownerRecoveryWindow(input).deadline, 1260000);
});
test('missing waker metadata fails closed in this qualification', () => {
  const input = fixture(); input.bucket.waker = null;
  assert.throws(() => ownerRecoveryWindow(input), /known post-kill waker/);
});
test('unknown waker metadata fails closed', () => {
  const input = fixture(); input.bucket.waker.node = 'foreign';
  assert.throws(() => ownerRecoveryWindow(input), /known post-kill waker/);
});
test('an excessive killed waker lease cannot extend the observation', () => {
  const input = fixture(); input.bucket.waker.expires_ms = 1180001;
  assert.throws(() => ownerRecoveryWindow(input), /exceeds the native TTL/);
});
test('an excessive node lease cannot extend the observation', () => {
  const input = fixture(); input.bucket.leases[0].expires_ms = 1010001;
  assert.throws(() => ownerRecoveryWindow(input), /Killed node expiry/);
});
test('a retry beyond the fixed observation ceiling is refused', () => {
  const input = fixture(); input.retryDue = 1260001;
  assert.throws(() => ownerRecoveryWindow(input), /fixed native-election ceiling/);
});
test('a survivor role write bounds its claim without treating renewal as first claim', () => {
  assert.deepEqual(survivorRoleObservation(ownerRecoveryWindow(fixture()), { at: 1185000, waker: { node: 'b', expires_ms: 1360000 } }, 'b'), { claimNotBefore: 1170000, claimNoLaterThan: 1180000, leaseWrittenAt: 1180000, observedAt: 1185000 });
});
test('a survivor cannot claim before the measured role expiry', () => {
  assert.throws(() => survivorRoleObservation(ownerRecoveryWindow(fixture()), { at: 1170000, waker: { node: 'b', expires_ms: 1349999 } }, 'b'), /before its recorded expiry/);
});
test('a survivor claim after the bounded election window is refused', () => {
  assert.throws(() => survivorRoleObservation(ownerRecoveryWindow(fixture()), { at: 1250001, waker: { node: 'b', expires_ms: 1430001 } }, 'b'), /exceeded the measured election window/);
});
test('a malformed role expiry is refused', () => {
  const input = fixture(); input.bucket.waker.expires_ms = '1170000';
  assert.throws(() => ownerRecoveryWindow(input), /safe nonnegative timestamp/);
});

const trail = () => [
  { startedAt: 1171000, bucket: { at: 1171100, waker: { node: 'a', expires_ms: 1170000 } } },
  { startedAt: 1184000, bucket: { at: 1185000, waker: { node: 'b', expires_ms: 1360000 } } },
];
test('role transfer is bracketed between the final owner sample and first survivor write', () => {
  assert.deepEqual(ownerRoleTrail(ownerRecoveryWindow(fixture()), trail(), 'a', 'b'), { claimNotBefore: 1171000, claimNoLaterThan: 1180000, leaseWrittenAt: 1180000, observedAt: 1185000, lastKilledRoleSampleStartedAt: 1171000 });
});
test('a missing intermediate role cannot be silently ignored', () => {
  const observations = trail(); observations.unshift({ startedAt: 1160000, bucket: { at: 1160000, waker: null } });
  assert.throws(() => ownerRoleTrail(ownerRecoveryWindow(fixture()), observations, 'a', 'b'), /Unknown role/);
});
test('a late killed-node renewal fails closed', () => {
  const observations = trail(); observations[0].bucket.waker.expires_ms = 1170001;
  assert.throws(() => ownerRoleTrail(ownerRecoveryWindow(fixture()), observations, 'a', 'b'), /role changed/);
});
test('a first survivor sample after the next tick cannot establish the claiming tick', () => {
  const observations = trail(); observations[1].bucket.at = 1240000;
  assert.throws(() => ownerRoleTrail(ownerRecoveryWindow(fixture()), observations, 'a', 'b'), /missed the claiming tick/);
});
test('an unbracketed survivor role cannot establish transfer', () => {
  assert.throws(() => ownerRoleTrail(ownerRecoveryWindow(fixture()), trail().slice(1), 'a', 'b'), /preceding killed-owner sample/);
});
test('a missing killed node lease fails qualification before waiting', () => {
  const input = fixture(); input.bucket.leases[0].missing = true;
  assert.throws(() => ownerRecoveryWindow(input), /killed node lease/);
});
test('a cut after its retry deadline fails qualification', () => {
  const input = fixture(); input.killedAt = 1007500; input.bucket.at = 1007600;
  assert.throws(() => ownerRecoveryWindow(input), /precede the persisted retry deadline/);
});
