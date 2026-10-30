import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAppArchiveRoutes, prepareAppArchiveRestoreRoutes } from '@fogd/platform/app-archive-routes';
import { appArchiveCapability } from '@fogd/platform/app-archive';
import { retirementRequest, retirementId } from '../../platform/test/fixtures/route-retirement.mjs';
import { observationSelection, observationReport } from '../src/observe/model.mjs';
import { supportedController } from '../src/controller-schema.mjs';
import { supportedDiagnosticController } from '../src/observe/controller-state.mjs';
import { observationKey } from '../src/observe/fingerprint.mjs';

function archived() {
  const { sourceProfile, profile, source, snapshot, binding, domain } = retirementRequest();
  for (const policy of [sourceProfile, profile]) Object.assign(policy, { schema: 4, controllerArgs: ['packages/platform/src/main-archive.mjs'] });
  profile.fleets[0].prefix = `archive-generations/${retirementId}`;
  for (const release of Object.values(source.state.deployments)) release.version = 'retained-version';
  const archive = { app: 'alpha', digest: source.state.deployments[source.state.apps.alpha.active].digest, id: retirementId, at: '2026-10-30T02:00:00.000Z' };
  const result = prepareAppArchiveRoutes({ profile, sourceProfile, source, snapshot, binding, domain, archive });
  return { state: result.state, authority: { record: result.record, digest: result.state.routeAuthority.settled.digest }, policy: profile, original: sourceProfile };
}
const context = { installation: 'test', boundary: 'matched-at-boundaries', controllerProcess: 'running-at-boundaries', observedAt: '2026-10-30T03:00:00Z' };

test('archived diagnostics expose retained identity without selecting or promoting a native fleet', () => {
  const { state, policy } = archived(), before = structuredClone(state), selection = observationSelection(state, 'alpha', policy);
  assert.equal(selection.reason, 'app-archived');
  assert.equal(selection.expected, undefined);
  assert.equal(selection.fleet, undefined);
  const report = observationReport(selection, context, { identity: 'verified', leases: 'current' });
  assert.equal(report.nativeReadiness, 'not-observed');
  assert.equal(report.recorded.active, null);
  assert.equal(report.recorded.routing, 'archived');
  assert.deepEqual(report.recorded.archive, { id: retirementId, status: 'archived', at: '2026-10-30T02:00:00.000Z', digest: state.appArchives.records[retirementId].digest });
  assert.equal(supportedController(state), false);
  assert.deepEqual(state, before);
});

test('pending restored archive diagnostics never sample native state before approval', () => {
  const f = archived(), result = prepareAppArchiveRestoreRoutes({ profile: f.original, sourceProfile: f.policy, source: { state: f.state, authority: f.authority },
    snapshot: 'd'.repeat(64), binding: 'e'.repeat(64), domain: 'localhost', restore: { archive: retirementId, expectedIdentity: f.state.appArchives.records[retirementId].identity, slot: 'slot-1' } });
  const selection = observationSelection(result.state, 'alpha', f.original);
  assert.equal(selection.reason, 'archive-recovery-pending');
  assert.equal(selection.expected, undefined);
  assert.equal(selection.recorded.archive.status, 'restored');
  assert.equal(observationReport(selection, context, { identity: 'verified', leases: 'current' }).nativeReadiness, 'uncertain');
});

test('an archive does not prevent held surviving apps from reporting native observations', () => {
  const { state, policy } = archived(), selection = observationSelection(state, 'beta', policy);
  assert.equal(selection.expected.slot, 'slot-2');
  assert.equal(selection.reason, 'http-routing-unconfirmed');
  assert.equal(selection.recorded.archive, undefined);
});

for (const [name, change] of [
  ['changed archive identity', s => { s.appArchives.records[retirementId].digest = 'a'.repeat(64); }],
  ['missing capability', s => { s.requirements = s.requirements.filter(value => value !== appArchiveCapability); }],
  ['missing registry', s => { delete s.appArchives; }],
  ['unlinked placeholder', s => { s.apps.alpha.archive = '00000000-0000-4000-8000-000000000099'; }],
]) test(`invalid archive metadata refuses diagnostics even for an unrelated survivor: ${name}`, () => {
  const { state, policy } = archived(); change(state);
  assert.throws(() => observationSelection(state, 'beta', policy), /unsupported/);
});

test('ordinary durable mode cannot interpret marked or unmarked archive records', () => {
  const { state, policy } = archived(); Object.assign(policy, { schema: 3, controllerArgs: ['packages/platform/src/main-durable.mjs'] });
  assert.equal(supportedDiagnosticController(state, policy), false);
  state.requirements = state.requirements.filter(value => value !== appArchiveCapability);
  assert.equal(supportedDiagnosticController(state, policy), false);
  Object.assign(policy, { schema: 2, controllerArgs: ['packages/platform/src/main.mjs'] }); delete policy.routing;
  state.requirements = [];
  assert.equal(supportedDiagnosticController(state, policy), false);
});

test('archive and recovery decision changes invalidate diagnostic boundaries for surviving apps', () => {
  const { state } = archived(), first = observationKey(state, 'beta');
  state.appArchives.records[retirementId].identity = 'd'.repeat(64);
  assert.notEqual(observationKey(state, 'beta'), first);
  const second = observationKey(state, 'beta'); state.decisions = [];
  assert.notEqual(observationKey(state, 'beta'), second);
});
