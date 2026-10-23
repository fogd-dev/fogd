import test from 'node:test';
import assert from 'node:assert/strict';
import { retentionReason, validRecord } from '../src/build-cache/policy.mjs';
import { pruningState } from '../../platform/test/fixtures/artifact-pruning.mjs';
const origin = 'https://owner.example', app = 'sample';
const id = '00000000-0000-4000-8000-000000000001', submission = '00000000-0000-4000-8000-000000000002';
const record = { schema: 1, app, id, phase: 'submitted', submission, digest: 'a'.repeat(64), server: origin };
const snapshot = (status, details = {}) => ({ apps: { [app]: details }, deployments: { [submission]: { id: submission, app, digest: record.digest, status } } });
for (const [status, expected] of Object.entries({ rejected: 'terminal-copy', superseded: 'terminal-copy', active: 'active-submission', pending: 'pending-submission', activating: 'activation-in-progress', failed: 'retryable-failure', retired: 'retired-submission', future: 'unrecognized-submission-state' })) {
  test(`retention distinguishes ${status}`, () => assert.equal(retentionReason(record, snapshot(status), origin), expected));
}
for (const phase of ['building', 'staged', 'uploading', 'uncertain', 'failed']) test(`${phase} copies never qualify for deletion`, () => {
  assert.equal(retentionReason({ ...record, phase }, snapshot('superseded'), origin), 'unfinished-or-unconfirmed');
});
for (const details of [{ active: submission }, { uncertain: submission }, { claim: {} }, { quarantined: true }, { retirement: {} }, { queueRecovery: {} }, { queueRecovery: { status: 'acknowledged' } }, { cronRecovery: {} }, { deliveryRecoveryError: 'private' }, { dispatchRecoveryError: 'private' }, { delivery: { hold: submission } }, { dispatch: { operation: 'pause' } }, { queueBootstrap: { phase: 'intent' } }, { cronBootstrap: { phase: 'intent' } }]) test(`controller reference ${JSON.stringify(details)} protects a terminal copy`, () => {
  assert.equal(retentionReason(record, snapshot('superseded', details), origin), 'controller-or-recovery-reference');
});
test('completed bootstrap and ordinary running controls do not pin superseded bytes', () => {
  assert.equal(retentionReason(record, snapshot('superseded', { queueBootstrap: { phase: 'application' }, dispatch: { hold: null, operation: null } }), origin), 'terminal-copy');
});
test('unknown requirements, app fields and unsupported state fail closed', () => {
  for (const state of [{}, { apps: [], deployments: {} }, { ...snapshot('superseded'), requirements: ['future'] }, snapshot('superseded', { future: false }), snapshot('superseded', null)]) assert.equal(retentionReason(record, state, origin), 'unsupported-controller-state');
});
test('receipt matching requires exact submission ID, app and content digest', () => {
  for (const change of [{ id }, { app: 'other' }, { digest: 'b'.repeat(64) }]) {
    const state = snapshot('superseded'); Object.assign(state.deployments[submission], change);
    assert.equal(retentionReason(record, state, origin), 'unverified-submission');
  }
  assert.equal(retentionReason(record, { apps: {}, deployments: {} }, origin), 'unverified-submission');
});
test('operator retention and controller identity override terminal status', () => {
  assert.equal(retentionReason(record, snapshot('rejected'), origin, true), 'operator-kept');
  assert.equal(retentionReason(record, snapshot('rejected'), 'https://other.example'), 'different-controller');
});
test('local records reject unsupported fields, malformed IDs and credential-bearing origins', () => {
  assert.equal(validRecord(record, app, id), true);
  for (const change of [{ phase: 'future' }, { schema: 2 }, { submission: 'not-an-id' }, { digest: 'bad' }, { server: 'https://user:secret@example.com' }, { unexpected: true }]) assert.equal(validRecord({ ...record, ...change }, app, id), false);
});

test('completed controller pruning permits independently eligible local build retention decisions', () => {
  assert.equal(retentionReason(record, pruningState(snapshot('rejected')), origin), 'terminal-copy');
});

test('pending controller pruning keeps local copies until the controller operation is settled', () => {
  assert.equal(retentionReason(record, pruningState(snapshot('rejected'), { pending: true, summary: true }), origin), 'controller-or-recovery-reference');
});
