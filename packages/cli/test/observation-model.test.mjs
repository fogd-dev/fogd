import test from 'node:test';
import assert from 'node:assert/strict';
import { observationSelection, observationReport } from '../src/observe/model.mjs';
import { observationKey } from '../src/observe/fingerprint.mjs';
import { pruningState } from '../../platform/test/fixtures/artifact-pruning.mjs';
const id = '00000000-0000-4000-8000-000000000001', app = 'sample', digest = 'a'.repeat(64);
const policy = { fleets: [{ id: 'slot-1', nodes: [{ host: 'slot-1-a' }, { host: 'slot-1-b' }] }] };
const fresh = () => ({ apps: { [app]: { route: 'active', active: id, slot: 'slot-1' } }, deployments: { [id]: { id, app, digest, status: 'active', step: 'complete', version: 'private-version', error: 'private-error', secretRevision: 'private-revision' } }, credentials: 'private-credentials', secrets: 'private-secret-values' });
const context = { installation: 'local-project', boundary: 'matched-at-boundaries', controllerProcess: 'running-at-boundaries', observedAt: '2026-10-22T12:00:00.000Z' };
const healthy = () => ({ identity: 'verified', leases: 'current', replicas: ['slot-1-a', 'slot-1-b'].map(node => ({ node, stateHTTPStatus: 200, healthHTTPStatus: 200, version: 'matches' })) });

test('matching signed replicas confirm only native readiness, never application or controller storage health', () => {
  const selection = observationSelection(fresh(), app, policy), report = observationReport(selection, context, healthy());
  assert.equal(report.nativeReadiness, 'confirmed'); assert.equal(report.runtimeIdentity, 'verified');
  assert.equal(report.applicationOutcomes, 'not-observed'); assert.equal(report.controllerStorageHealth, 'not-observed');
  assert.deepEqual(report.recorded.active, { id, digest }); assert.equal(report.observedAt, context.observedAt);
  assert.equal(JSON.stringify(report).includes('private-'), false);
});
for (const [field, value] of [['stateHTTPStatus', null], ['stateHTTPStatus', 503], ['healthHTTPStatus', 503], ['healthHTTPStatus', null], ['version', 'differs'], ['version', 'unknown']]) test(`one replica with ${field}=${value} makes readiness uncertain`, () => {
  const sample = healthy(); sample.replicas[1][field] = value;
  assert.equal(observationReport(observationSelection(fresh(), app, policy), context, sample).nativeReadiness, 'uncertain');
});
for (const [field, value] of [['boundary', 'changed'], ['boundary', 'unavailable'], ['controllerProcess', 'not-running'], ['controllerProcess', 'unconfirmed']]) test(`${field}=${value} cannot be promoted by healthy nodes`, () => {
  assert.equal(observationReport(observationSelection(fresh(), app, policy), { ...context, [field]: value }, healthy()).nativeReadiness, 'uncertain');
});
test('an unverified identity or missing replica cannot confirm readiness', () => {
  const selection = observationSelection(fresh(), app, policy);
  for (const sample of [null, { ...healthy(), identity: 'unconfirmed' }, { ...healthy(), replicas: [healthy().replicas[0]] }, { identity: 'verified', replicas: {} }]) assert.equal(observationReport(selection, context, sample).nativeReadiness, 'uncertain');
});
for (const details of [{ route: 'future' }, { quarantined: true }, { uncertain: id }, { retirement: {} }, { dispatch: { hold: id } }, { delivery: { operation: 'pause' } }, { cronRecovery: { status: 'required' }, dispatch: {} }]) test(`withheld state ${JSON.stringify(details)} does not contact or confirm a runtime`, () => {
  const state = fresh(); Object.assign(state.apps[app], details);
  // Hold/migration/retirement references must have statuses consistent with them.
  if (details.uncertain || details.dispatch?.hold) state.deployments[id].status = 'failed';
  if (details.retirement) state.deployments[id].status = 'retired';
  if (details.uncertain || details.dispatch?.hold) state.apps[app].active = null;
  const selection = observationSelection(state, app, policy);
  assert.ok(selection.reason); assert.equal(selection.expected, undefined);
  assert.notEqual(observationReport(selection, context, healthy()).nativeReadiness, 'confirmed');
});
test('pending-only app reports not-observed with no active runtime selection', () => {
  const state = fresh(); state.apps = {}; state.deployments[id].status = 'pending'; state.deployments[id].step = 'submitted';
  const selection = observationSelection(state, app, policy);
  assert.equal(selection.reason, 'no-active-approved-release'); assert.equal(selection.fleet, undefined);
  assert.equal(observationReport(selection, { ...context, boundary: 'single-read' }, null).nativeReadiness, 'not-observed');
});
test('unknown controller requirements and app fields fail closed', () => {
  const state = fresh(); state.requirements = ['future-protocol'];
  assert.throws(() => observationSelection(state, app, policy), /unsupported/);
  delete state.requirements; state.apps[app].futureFlag = false;
  assert.equal(observationSelection(state, app, policy).reason, 'unsupported-controller-state');
});
test('snapshots are permitted as private disk metadata but never included in the report', () => {
  const state = fresh(); state.apps[app].queueSnapshot = { id: 'private-snapshot' };
  const report = observationReport(observationSelection(state, app, policy), context, healthy());
  assert.equal(report.nativeReadiness, 'confirmed'); assert.equal(JSON.stringify(report).includes('private-snapshot'), false);
});
test('fingerprints bind the selected app and release without including unrelated app changes', () => {
  const state = fresh(), key = observationKey(state, app);
  state.apps.other = { route: 'paused' }; assert.equal(observationKey(state, app), key);
  state.deployments[id].version = 'different-private-version'; assert.notEqual(observationKey(state, app), key);
});
test('raw worker data and foreign nodes cannot become public diagnostics', () => {
  const sample = healthy(); sample.credentials = 'private-token'; sample.replicas.push({ node: 'another-app-node', healthHTTPStatus: 200 });
  sample.replicas[0].raw = 'private-state'; sample.replicas[0].version = 'private-actual-version';
  const report = observationReport(observationSelection(fresh(), app, policy), context, sample);
  assert.equal(report.replicas.length, 2); assert.equal(report.replicas[0].version, 'unknown'); assert.equal(JSON.stringify(report).includes('private-'), false);
});

test('array-coerced digest metadata cannot confirm native readiness', () => {
  const state = fresh(); state.deployments[id].digest = [digest];
  assert.throws(() => observationSelection(state, app, policy), /identity is unsupported/);
});
test('an active record with an incomplete or unknown activation step remains unverified', () => {
  const state = fresh(); state.deployments[id].step = 'future-step';
  assert.equal(observationSelection(state, app, policy).reason, 'unverified-approved-version');
});

for (const field of ['queueBootstrap', 'cronBootstrap']) test(`${field} intent protects observation until the application phase`, () => {
  const state = fresh(); state.apps[app][field] = { phase: 'intent' };
  assert.equal(observationSelection(state, app, policy).reason, 'controller-withholds-application');
  state.apps[app][field].phase = 'application'; assert.equal(observationSelection(state, app, policy).reason, null);
});
test('acknowledged recovery does not make native HTTP readiness permanently uncertain', () => {
  const state = fresh(); state.apps[app].cronRecovery = { status: 'acknowledged' };
  assert.equal(observationReport(observationSelection(state, app, policy), context, healthy()).nativeReadiness, 'confirmed');
});
for (const unavailable of ['timeout', 'helper-failed', 'scope-unconfirmed']) test(`${unavailable} is distinguished from an unready application replica`, () => {
  const report = observationReport(observationSelection(fresh(), app, policy), context, { ...healthy(), unavailable });
  assert.equal(report.nativeReadiness, 'uncertain'); assert.equal(report.reason, unavailable === 'timeout' ? 'observer-timeout' : unavailable === 'scope-unconfirmed' ? 'local-scope-unconfirmed' : 'observer-unavailable');
});

test('completed artifact pruning does not make an unchanged active release unsupported', () => {
  const state = pruningState(fresh());
  assert.equal(observationSelection(state, app, policy).reason, null);
  assert.equal(observationReport(observationSelection(state, app, policy), context, healthy()).nativeReadiness, 'confirmed');
});

test('pending artifact pruning withholds observation and participates in boundary comparison', () => {
  const before = fresh(), pending = pruningState(before, { pending: true });
  assert.equal(observationSelection(pending, app, policy).reason, 'controller-artifact-prune-pending');
  assert.notEqual(observationKey(pending, app), observationKey(before, app));
});

test('malformed artifact pruning cannot confirm a local observation', () => {
  const state = pruningState(fresh()); state.artifactPruning.last.reclaimedArtifactBytes++;
  assert.throws(() => observationSelection(state, app, policy), /unsupported/);
});
test('newly unknown requirements change the observation boundary', () => {
  const before = fresh(), after = fresh(); after.requirements = ['future-protocol'];
  assert.notEqual(observationKey(before, app), observationKey(after, app));
});

for (const field of ['requirements', 'artifactPruning']) test(`an explicit null ${field} differs from absent controller metadata at a probe boundary`, () => {
  const before = fresh(), after = fresh(); after[field] = null;
  assert.notEqual(observationKey(before, app), observationKey(after, app));
});

test('a paused approved app exposes native facts without becoming ready', () => {
  const state = fresh(); state.apps[app].route = 'paused';
  const selection = observationSelection(state, app, policy);
  assert.equal(selection.expected?.slot, 'slot-1');
  const report = observationReport(selection, context, healthy());
  assert.equal(report.reason, 'controller-withholds-application');
  assert.equal(report.nativeReadiness, 'uncertain');
  assert.equal(report.runtimeIdentity, 'verified');
  assert.equal(report.runtimeLeases, 'current');
  assert.equal(report.replicas.length, 2);
});
for (const [leases, wanted, reason] of [['expired', 'expired', 'runtime-leases-expired'], ['unconfirmed', 'unconfirmed', 'runtime-leases-unconfirmed'], [undefined, 'unconfirmed', 'runtime-leases-unconfirmed']]) test(`leases ${leases} cannot be promoted by signed healthy replicas`, () => {
  const report = observationReport(observationSelection(fresh(), app, policy), context, { ...healthy(), leases });
  assert.equal(report.nativeReadiness, 'uncertain');
  assert.equal(report.runtimeLeases, wanted); assert.equal(report.reason, reason);
});
