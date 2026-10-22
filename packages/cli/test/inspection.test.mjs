import { cronSnapshotSource } from './fixtures/cron-snapshot.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationInspection } from '../src/inspection.mjs';
const id = '00000000-0000-4000-8000-000000000001', second = '00000000-0000-4000-8000-000000000002';
const digest = 'a'.repeat(64), otherDigest = 'b'.repeat(64);
const release = { id, app: 'guestbook', digest, status: 'active', step: 'complete', submittedAt: '2026-10-22T12:00:00.000Z' };

test('an active approval and recorded routing do not imply live health', () => {
  const state = { apps: { guestbook: { active: id, route: 'active' } }, deployments: { [id]: release } };
  assert.deepEqual(applicationInspection(state, 'guestbook'), { schema: 1, app: 'guestbook', source: 'controller-recorded', runtimeHealth: 'not-observed', applicationOutcomes: 'not-observed',
    routing: 'active', retired: false, quarantined: false, quarantineReason: null, ownershipClaim: null, uncertainMigration: null, active: { id, digest },
    releases: [{ id, digest, submittedAt: '2026-10-22T12:00:00.000Z', status: 'active', step: 'complete', hasPrivateDiagnostic: false, secretRevisionSelected: false }], controls: {}, nextChecks: [] });
  assert.deepEqual(state.apps.guestbook, { active: id, route: 'active' });
});
test('a pending-only submission has no assigned route or active release', () => {
  const report = applicationInspection({ apps: {}, deployments: { [id]: { ...release, status: 'pending', step: 'submitted' } } }, 'guestbook');
  assert.equal(report.routing, 'unassigned'); assert.equal(report.active, null);
  assert.match(report.nextChecks[0], /awaits review/);
});
test('failed migration points to private diagnostics without emitting SQL, credentials, versions or another app', () => {
  const state = { csrf: 'private-csrf', credentials: 'private-credentials', secrets: 'private-secrets',
    apps: { guestbook: { route: 'paused', uncertain: id, reason: 'private-reason', dispatch: { desired: 'paused', observed: 'unknown', observedAt: null, operation: 'pause', hold: id, version: 'private-control-version' } } },
    deployments: { [id]: { ...release, status: 'failed', step: 'migrating', error: 'private-sql-data', version: 'private-runtime-version', secretRevision: 'private-revision' }, [second]: { ...release, id: second, app: 'another-app', digest: otherDigest } } };
  const report = applicationInspection(state, 'guestbook'), text = JSON.stringify(report);
  assert.deepEqual(report.uncertainMigration, { id, digest }); assert.equal(report.releases.length, 1);
  assert.equal(report.releases[0].hasPrivateDiagnostic, true); assert.equal(report.releases[0].secretRevisionSelected, true);
  assert.deepEqual(report.controls.dispatch, { desired: 'paused', recordedObserved: 'unknown', recordedObservedAt: null, operation: 'pause', hold: { id, digest }, recoveryError: null, recoveryAcknowledgmentRequired: false, recoveryFindings: [], recoveryCheckError: null });
  for (const value of ['private-csrf', 'private-credentials', 'private-secrets', 'private-reason', 'private-sql-data', 'private-runtime-version', 'private-control-version', 'private-revision', 'another-app', otherDigest]) assert.equal(text.includes(value), false, value);
  assert.ok(report.nextChecks.some(value => value.includes('Migration outcome is uncertain')));
  assert.ok(report.nextChecks.some(value => value.includes('authenticated admin interface')));
});
for (const step of ['queue-bootstrap-intent', 'publishing-queue-bootstrap', 'waiting-for-queue-bootstrap', 'pausing-delivery', 'queue-application-intent', 'releasing-delivery', 'transferring-delivery-hold']) {
  test(`owner state retains the queue activation step ${step}`, () => {
    const report = applicationInspection({ apps: {}, deployments: { [id]: { ...release, status: 'failed', step } } }, 'guestbook');
    assert.equal(report.releases[0].step, step);
  });
}
test('quarantine, retirement, claims and recovery remain separate recorded conditions', () => {
  const report = applicationInspection({ apps: { guestbook: { route: 'paused', retirement: {}, quarantined: true, claim: { deployment: id, digest },
    delivery: { desired: 'running', observed: 'paused', observedAt: '2026-10-22T12:00:00.000Z', operation: null, hold: id }, queueRecovery: { status: 'required', checkError: 'private-recovery-error' } } }, deployments: { [id]: { ...release, status: 'failed' } } }, 'guestbook');
  assert.equal(report.retired, true); assert.equal(report.quarantined, true); assert.deepEqual(report.ownershipClaim, { id, digest });
  assert.equal(report.controls.delivery.desired, 'running'); assert.equal(report.controls.delivery.recordedObserved, 'paused');
  assert.equal(report.controls.delivery.recoveryAcknowledgmentRequired, true);
  assert.equal(JSON.stringify(report).includes('private-recovery-error'), false);
});
test('unknown protocol values are labeled unknown rather than copied into diagnostics', () => {
  const report = applicationInspection({ apps: { guestbook: { route: 'private-route', dispatch: { desired: 'private-desired', observed: 'private-observed', operation: 'private-operation', observedAt: 'private-time' } } }, deployments: { [id]: { ...release, status: 'private-status', step: 'private-step', submittedAt: 'private-submission-time' } } }, 'guestbook');
  assert.equal(report.routing, 'unknown'); assert.equal(report.releases[0].status, 'unknown'); assert.equal(report.releases[0].step, 'unknown');
  assert.equal(report.releases[0].submittedAt, null); assert.equal(report.controls.dispatch.recordedObservedAt, null);
  assert.equal(JSON.stringify(report).includes('private-'), false);
  assert.ok(report.nextChecks.some(value => value.includes('unrecognized')));
});
for (const [name, app] of [['active', { active: second }], ['held', { dispatch: { hold: second } }]]) test(`a different-app ${name} reference refuses inspection`, () => {
  assert.throws(() => applicationInspection({ apps: { guestbook: app }, deployments: { [id]: release, [second]: { ...release, app: 'other', id: second } } }, 'guestbook'), /different-app release/);
});
test('duplicate deployment IDs cannot ambiguously identify an active release', () => {
  assert.throws(() => applicationInspection({ apps: { guestbook: { active: id } }, deployments: { first: release, second: { ...release, digest: otherDigest } } }, 'guestbook'), /ambiguous deployment/);
});
test('history is ordered by recorded submission time with stable IDs for ties', () => {
  const report = applicationInspection({ apps: {}, deployments: { [id]: release, [second]: { ...release, id: second, submittedAt: '2026-10-23T12:00:00.000Z' } } }, 'guestbook');
  assert.deepEqual(report.releases.map(value => value.id), [second, id]);
});
test('an absent app including an inherited object property is not a recorded application', () => {
  assert.throws(() => applicationInspection({ apps: {}, deployments: {} }, 'constructor'), /No recorded application/);
});
for (const state of [{}, { apps: [], deployments: {} }, { apps: { guestbook: null }, deployments: {} }]) test('unsupported state fails without dumping its contents', () => {
  assert.throws(() => applicationInspection(state, 'guestbook'), /unsupported application state/);
});

test('retired routing is recognized without implying a running application', () => {
  const report = applicationInspection({ apps: { guestbook: { route: 'retired', retirement: {}, active: id } }, deployments: { [id]: { ...release, status: 'retired' } } }, 'guestbook');
  assert.equal(report.routing, 'retired'); assert.equal(report.retired, true); assert.deepEqual(report.active, { id, digest }); assert.equal(report.releases[0].status, 'retired'); assert.equal(report.runtimeHealth, 'not-observed');
});
test('a hold cannot belong to an active release', () => {
  assert.throws(() => applicationInspection({ apps: { guestbook: { delivery: { hold: id } } }, deployments: { [id]: release } }, 'guestbook'), /delivery hold has an invalid release status/);
});
test('foreign migration reference identifies the inconsistent field without exposing another app', () => {
  assert.throws(() => applicationInspection({ apps: { guestbook: { uncertain: second } }, deployments: { [id]: release, [second]: { ...release, id: second, app: 'other' } } }, 'guestbook'), /uncertain migration references an unavailable or different-app release/);
});
test('known quarantine and recovery reasons explain why while unknown text stays withheld', () => {
  const reason = 'Bucket owner has no controller record; restore controller backup';
  const finding = 'Possible message expiration or completion during snapshot shutdown; reconcile retained application input before acknowledging';
  const checkError = 'Queue runtime is unavailable or its approved generation is not ready; retry after the replicas recover';
  const report = applicationInspection({ apps: { guestbook: { quarantined: true, reason, delivery: { hold: null }, queueRecovery: { status: 'required', diagnosis: finding, checkError } } }, deployments: {} }, 'guestbook');
  assert.equal(report.quarantineReason, reason); assert.deepEqual(report.controls.delivery.recoveryFindings, [finding]); assert.equal(report.controls.delivery.recoveryCheckError, checkError);
});

test('a recorded observation that disagrees with intent needs investigation even without a pending operation', () => {
  const report = applicationInspection({ apps: { guestbook: { dispatch: { desired: 'running', observed: 'paused', observedAt: '2026-10-22T12:00:00.000Z', operation: null } } }, deployments: {} }, 'guestbook');
  assert.ok(report.nextChecks.some(value => value.includes('observation remains unconfirmed')));
});
test('an activation hold overrides running intent when interpreting a recorded pause', () => {
  const report = applicationInspection({ apps: { guestbook: { dispatch: { desired: 'running', observed: 'paused', observedAt: '2026-10-22T12:00:00.000Z', operation: null, hold: id } } }, deployments: { [id]: { ...release, status: 'failed' } } }, 'guestbook');
  assert.ok(report.nextChecks.some(value => value.includes('held by an activation')));
  assert.equal(report.nextChecks.some(value => value.includes('observation remains unconfirmed')), false);
});

test('the real cron fixture retains its ISO observation time without exposing native version', () => {
  const { state } = cronSnapshotSource({ deployment: id, id: second, at: Date.parse('2026-10-22T12:00:00.000Z') });
  const report = applicationInspection(state, 'refresh');
  assert.equal(report.controls.dispatch.recordedObservedAt, '2026-10-22T12:00:00.000Z');
  assert.equal(report.controls.dispatch.recordedObserved, 'paused'); assert.equal(report.runtimeHealth, 'not-observed');
  assert.equal(JSON.stringify(report).includes('private-cron-runtime-version'), false);
});
test('an active pointer cannot identify a failed release', () => {
  assert.throws(() => applicationInspection({ apps: { guestbook: { active: id } }, deployments: { [id]: { ...release, status: 'failed' } } }, 'guestbook'), /active release has an invalid release status/);
});
test('rejected submissions remain visible alongside the active approval', () => {
  const report = applicationInspection({ apps: { guestbook: { active: id, route: 'active' } }, deployments: { [id]: release, [second]: { ...release, id: second, status: 'rejected', step: 'submitted' } } }, 'guestbook');
  assert.equal(report.releases.find(value => value.id === second).status, 'rejected'); assert.deepEqual(report.active, { id, digest });
});

test('a deployment key that differs from its public ID refuses rather than naming the wrong release', () => {
  assert.throws(() => applicationInspection({ apps: { guestbook: { active: id } }, deployments: { [second]: release } }, 'guestbook'), /inconsistent deployment keys/);
});
test('an uncertain migration cannot point to a completed active release', () => {
  assert.throws(() => applicationInspection({ apps: { guestbook: { active: id, uncertain: id } }, deployments: { [id]: release } }, 'guestbook'), /uncertain migration has an invalid release status/);
});
for (const [surface, message, expected] of [
  ['delivery', 'Queue pause could not be confirmed; retry the held activation after restoring its fleet', 'Queue pause could not be confirmed; retry the held activation after restoring its fleet'],
  ['dispatch', 'Cron pause could not be confirmed; retry the held activation after restoring its fleet', 'Cron pause could not be confirmed; retry the held activation after restoring its fleet'],
  ['dispatch', 'private recovery transport error', 'unrecognized'],
]) test(`recorded ${surface} pause recovery uses known vocabulary: ${expected}`, () => {
  const report = applicationInspection({ apps: { guestbook: { [surface]: { desired: 'paused', observed: 'unknown', observedAt: null }, [`${surface}RecoveryError`]: message } }, deployments: {} }, 'guestbook');
  assert.equal(report.controls[surface].recoveryError, expected);
});
test('multiple recorded cron recovery findings preserve known explanations and withhold arbitrary text', () => {
  const report = applicationInspection({ apps: { guestbook: { dispatch: { desired: 'paused', observed: 'unknown', observedAt: null }, cronRecovery: { status: 'required', diagnoses: ['Restored native dispatch was not held; work may have run before confirmation. Restore a qualified stopped snapshot.', 'private recovery details'] } } }, deployments: {} }, 'guestbook');
  assert.deepEqual(report.controls.dispatch.recoveryFindings, ['Restored native dispatch was not held; work may have run before confirmation. Restore a qualified stopped snapshot.', 'unrecognized']);
});
