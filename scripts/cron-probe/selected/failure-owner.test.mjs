import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedOwnerRetry, assertStoppedLease, assertRecoveredOwner } from './failure-owner.mjs';

const time = 60000;
function snapshot() {
  const selected = ['advisory', 'inventory'].flatMap(job => [0, 1].map(id => ({ id: `${job}-${id}`, job, outcome: job === 'advisory' ? 'thrown' : 'success', scheduled_time: time, cron: '* * * * *', no_retry_called: 0 })));
  const replicas = ['owner-id', 'peer-id'].map(node => ({ node, state: { quiescing: 0, evicting: 0, releasing: 0, adopting: 0, restoring: 0, residents: node === 'owner-id' ? ['.cron:refresh'] : [], deployment: { version: 'release', generation: 7, swapping: 0, cells: node === 'owner-id' ? { '.cron:refresh': 7 } : {} } } }));
  return { replicas, selected, completedAt: 65000, info: { paused: false, nextAlarm: 70000 }, bucket: { owner: { node: 'owner-id', epoch: 3 }, waker: { node: 'owner-id', expires_ms: 180000 }, wakes: [{ key: 'retry', due_ms: 70000 }] }, ownerState: { version: 'release', generation: 7, cells: { '.cron:refresh': 7 } } };
}
test('owner cut selects the persisted retry after two advisory failures', () => {
  assert.deepEqual(selectedOwnerRetry(snapshot(), time, 'release'), { key: 'retry', due_ms: 70000 });
});
for (const [name, mutate] of [
  ['third advisory attempt', value => value.selected.push({ ...value.selected[0] })],
  ['expired cut margin', value => { value.completedAt = 69000; }],
  ['different waker', value => { value.bucket.waker.node = 'survivor-id'; }],
  ['stale cron generation', value => { value.ownerState.cells['.cron:refresh'] = 6; }],
  ['different release', value => { value.ownerState.version = 'other'; }],
]) test(`owner cut refuses ${name}`, () => {
  const value = snapshot(); mutate(value); assert.throws(() => selectedOwnerRetry(value, time, 'release'));
});
test('a pending logged callback postpones the cut', () => {
  const value = snapshot(); value.selected[0].outcome = 'pending'; assert.equal(selectedOwnerRetry(value, time, 'release'), null);
});
test('a stopped node may expire or disappear but cannot renew its lease', () => {
  const bucket = { leases: [{ expectedNode: 'owner-id', node: 'owner-id', expires_ms: 100, missing: false }] };
  assert.doesNotThrow(() => assertStoppedLease(bucket, 'owner-id', 100));
  bucket.leases[0].expires_ms = 101; assert.throws(() => assertStoppedLease(bucket, 'owner-id', 100));
  bucket.leases[0] = { expectedNode: 'owner-id', node: null, missing: true };
  assert.doesNotThrow(() => assertStoppedLease(bucket, 'owner-id', 100));
});

function recovery() {
  const before = snapshot(); before.rows = before.selected.map((row, index) => ({ ...row, entered_at: time + (index % 2) * 4000 + 100, finished_at: time + (index % 2) * 4000 + 101, instance: 'old-owner' }));
  const fresh = ['inventory', 'advisory'].map(job => ({ id: `${job}-new`, job, outcome: 'success', scheduled_time: time, cron: '* * * * *', no_retry_called: 0, entered_at: 200000, finished_at: 200001, instance: 'survivor' }));
  return { observed: { bucket: { owner: { node: 'survivor-id', epoch: 4 } }, rows: [...before.rows, ...fresh] }, before };
}
function verifyRecovery(value) { return assertRecoveredOwner(value.observed, value.before, 'survivor-id', time, 70000, { deadline: 250000 }, { claimNotBefore: 180000 }); }
test('original retry succeeds once per job after the survivor role claim', () => {
  assert.equal(verifyRecovery(recovery()).length, 2);
});
for (const [name, mutate] of [
  ['duplicate fresh success', value => { value.observed.rows.push({ ...value.observed.rows.at(-1), id: 'duplicate' }); }],
  ['fresh thrown attempt', value => { value.observed.rows.at(-1).outcome = 'thrown'; }],
  ['unchanged owner epoch', value => { value.observed.bucket.owner.epoch = 3; }],
  ['old owner instance succeeds', value => { value.observed.rows.at(-1).instance = 'old-owner'; }],
  ['success before the role claim', value => { value.observed.rows.at(-1).entered_at = 179999; }],
  ['completion beyond the recovery bound', value => { value.observed.rows.at(-1).finished_at = 250001; }],
]) test(`owner recovery refuses ${name}`, () => {
  const value = recovery(); mutate(value); assert.throws(() => verifyRecovery(value));
});
test('a later natural minute can coexist with the original recovered occurrence', () => {
  const value = recovery(); value.observed.rows.push({ ...value.observed.rows.at(-1), id: 'later-minute', scheduled_time: 300000, entered_at: 300001, finished_at: 300002 });
  assert.equal(verifyRecovery(value).length, 2);
});

test('a co-located owner and waker must still match the staged waker', () => {
  assert.throws(() => selectedOwnerRetry(snapshot(), time, 'release', 'other-staged-node'), /staged waker/);
});

for (const counter of ['quiescing', 'evicting', 'releasing', 'adopting', 'restoring']) test(`owner cut waits while a replica reports ${counter}`, () => {
  const value = snapshot(); value.replicas[1].state[counter] = 1;
  assert.equal(selectedOwnerRetry(value, time, 'release'), null);
});
test('owner cut refuses a nonresident cron cell', () => {
  const value = snapshot(); value.replicas[0].state.residents = [];
  assert.throws(() => selectedOwnerRetry(value, time, 'release'), /residency/);
});
