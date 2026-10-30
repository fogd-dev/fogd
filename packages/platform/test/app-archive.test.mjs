import test from 'node:test';
import assert from 'node:assert/strict';
import { projectAppArchive, projectAppArchiveRestore, validateAppArchives, appArchiveCapability } from '../src/app-archive.mjs';
import { validateRetirementState } from '../src/retirement.mjs';
import { artifactRetentionDecision } from '../src/artifact-retention.mjs';
import { policy } from './fixtures/runtime-policy.mjs';
import { runtimePolicyIdentity } from '../src/runtime-policy.mjs';

const release = '11111111-1111-4111-8111-111111111111', pending = '22222222-2222-4222-8222-222222222222';
const archive = '33333333-3333-4333-8333-333333333333', beta = '44444444-4444-4444-8444-444444444444';
const digest = 'a'.repeat(64), snapshot = 'b'.repeat(64);
function fixture() {
  const sourceProfile = { ...policy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'] };
  const profile = structuredClone(sourceProfile);
  profile.fleets[0].prefix = `archive-generations/${archive}`;
  profile.fleets[0].nodes[0].id = `slot-1-a-${archive}`;
  profile.fleets[0].nodes[1].id = `slot-1-b-${archive}`;
  const state = { requirements: [], apps: { alpha: { slot: 'slot-1', route: 'active', active: release,
    resources: { script: 'alpha', d1: [{ binding: 'DB', database_name: 'alpha-db' }], r2: [{ binding: 'BUCKET', bucket_name: 'alpha-bucket' }] }, migrations: [{ name: 'initial.sql', digest }], privateConfiguration: true } },
    deployments: { [release]: { id: release, app: 'alpha', digest, status: 'active', version: 'alpha-version', secretRevision: 'old-secret-revision' },
      [pending]: { id: pending, app: 'alpha', digest: 'c'.repeat(64), status: 'pending' } },
    credentials: { revoked: ['former-builder'], active: ['current-builder'] }, artifactPins: { schema: 1, releases: { [release]: digest } } };
  return { state, sourceProfile, profile, snapshot, app: 'alpha', digest, id: archive, at: '2026-10-30T02:00:00.000Z' };
}
function restoration() {
  const f = fixture(), state = projectAppArchive(f);
  state.apps.beta = { slot: 'slot-1', route: 'active', active: beta, migrations: [{ name: 'beta.sql' }] };
  state.deployments[beta] = { id: beta, app: 'beta', digest: 'd'.repeat(64), status: 'active' };
  state.credentials = { revoked: ['former-builder', 'another-builder'], active: ['new-builder'] };
  const profile = structuredClone(f.profile);
  profile.fleets[1].prefix = 'slots/slot-1';
  profile.fleets[1].nodes[0].id = 'slot-1-a'; profile.fleets[1].nodes[1].id = 'slot-1-b';
  return { state, sourceProfile: f.profile, profile, snapshot: 'e'.repeat(64), archive, expectedIdentity: state.appArchives.records[archive].identity, slot: 'slot-2' };
}
const refused = { code: 'APP_ARCHIVE_REFUSED' };

test('archival retains the exact app and release while reserving its name without a fleet assignment', () => {
  const input = fixture(), before = structuredClone(input);
  const result = projectAppArchive(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.apps.alpha, { slot: null, route: 'archived', active: release, archive });
  assert.deepEqual(result.appArchives.records[archive].app, before.state.apps.alpha);
  assert.deepEqual(result.appArchives.records[archive].deployments, before.state.deployments);
  assert.equal(result.appArchives.records[archive].snapshot, snapshot);
  assert.equal(result.deployments[release].status, 'archived');
  assert.equal(result.deployments[pending].status, 'archived');
  assert.deepEqual(result.credentials, before.state.credentials);
  assert.deepEqual(result.artifactPins, before.state.artifactPins);
  assert.ok(result.requirements.includes(appArchiveCapability));
});

test('restoring alpha after beta reuses its old slot preserves beta and current credentials', () => {
  const input = restoration(), before = structuredClone(input);
  const result = projectAppArchiveRestore(input);
  assert.deepEqual(input, before);
  assert.equal(result.apps.alpha.slot, 'slot-2');
  assert.equal(result.apps.alpha.route, 'paused');
  assert.deepEqual(result.apps.alpha.archiveRecovery, { archive, identity: input.expectedIdentity, status: 'pending' });
  assert.deepEqual(result.apps.alpha.migrations, [{ name: 'initial.sql', digest }]);
  assert.deepEqual(result.apps.beta, before.state.apps.beta);
  assert.deepEqual(result.deployments[beta], before.state.deployments[beta]);
  assert.deepEqual(result.credentials, { revoked: ['former-builder', 'another-builder'], active: ['new-builder'] });
  assert.equal(result.deployments[release].status, 'active');
  assert.equal(result.deployments[pending].status, 'pending');
  assert.equal(result.appArchives.records[archive].status, 'restored');
});

test('shipping runtimes refuse the archive capability instead of loading a new lifecycle they do not implement', () => {
  const f = fixture(), state = projectAppArchive(f);
  assert.throws(() => validateRetirementState(state, f.profile.fleets), /unsupported platform capability/);
});

test('archive references protect retained artifacts independently of explicit operator pins', () => {
  const f = fixture(), state = projectAppArchive(f); delete state.artifactPins;
  const result = artifactRetentionDecision(state, [{ id: release, kind: 'directory', digest, bytes: 123 }, { id: pending, kind: 'directory', digest: 'c'.repeat(64), bytes: 456 }]);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.protectedArtifactBytes, 579);
});

test('restoration refuses a different retained archive identity', () => {
  const input = restoration(); input.expectedIdentity = '0'.repeat(64);
  assert.throws(() => projectAppArchiveRestore(input), refused);
});
test('restoration refuses capacity already assigned to another app', () => {
  const input = restoration(); input.slot = 'slot-1';
  assert.throws(() => projectAppArchiveRestore(input), refused);
});
test('restoration refuses substituting an empty namespace for the retained app data', () => {
  const input = restoration(); input.profile.fleets[1].prefix = 'empty/namespace';
  assert.throws(() => projectAppArchiveRestore(input), refused);
});
test('restoration refuses another runtime image even if its storage identity looks the same', () => {
  const input = restoration(); input.sourceProfile.image = 'sha256:' + 'f'.repeat(64); input.profile.image = input.sourceProfile.image;
  assert.throws(() => projectAppArchiveRestore(input), refused);
});
test('archival refuses changing the unrelated fleet namespace', () => {
  const input = fixture(); input.profile.fleets[1].prefix = 'changed/peer';
  assert.throws(() => projectAppArchive(input), refused);
});
test('archival refuses an interrupted activation', () => {
  const input = fixture(); input.state.deployments[pending].status = 'activating';
  assert.throws(() => projectAppArchive(input), refused);
});
test('archival refuses unresolved app state', () => {
  const input = fixture(); input.state.apps.alpha.uncertain = release;
  assert.throws(() => projectAppArchive(input), refused);
});
test('archival refuses a stale active digest', () => {
  const input = fixture(); input.digest = '0'.repeat(64);
  assert.throws(() => projectAppArchive(input), refused);
});
test('archive validation refuses changed retained data references', () => {
  const f = fixture(), state = projectAppArchive(f); state.appArchives.records[archive].snapshot = '0'.repeat(64);
  assert.throws(() => validateAppArchives(state, f.profile), refused);
});
test('archive validation refuses changing the reserved name', () => {
  const f = fixture(), state = projectAppArchive(f); state.apps.alpha.archive = '55555555-5555-4555-8555-555555555555';
  assert.throws(() => validateAppArchives(state, f.profile), refused);
});
test('restoration cannot spend an archive twice', () => {
  const input = restoration(), state = projectAppArchiveRestore(input);
  assert.throws(() => projectAppArchiveRestore({ ...input, state, sourceProfile: input.profile }), refused);
});
test('archive validation refuses a restored app whose pending recovery gate was bypassed', () => {
  const input = restoration(), state = projectAppArchiveRestore(input); state.apps.alpha.route = 'active';
  assert.throws(() => validateAppArchives(state, input.profile), refused);
});
test('archive validation refuses deleting a pending restoration gate', () => {
  const input = restoration(), state = projectAppArchiveRestore(input); delete state.apps.alpha.archiveRecovery;
  assert.throws(() => validateAppArchives(state, input.profile), refused);
});
test('restoration refuses moving retained native identities into a different storage bucket', () => {
  const input = restoration(); input.sourceProfile.bucket = 'foreign-bucket'; input.profile.bucket = 'foreign-bucket';
  assert.throws(() => projectAppArchiveRestore(input), refused);
});
test('restoration refuses moving retained native identities to a different storage endpoint', () => {
  const input = restoration(); input.sourceProfile.storage.endpoint = 'http://other-minio:9000'; input.profile.storage.endpoint = 'http://other-minio:9000';
  assert.throws(() => projectAppArchiveRestore(input), refused);
});
test('archive validation refuses reusing a retained native node identity on a configured fleet', () => {
  const input = restoration(); input.sourceProfile.fleets[0].nodes[0].id = 'slot-1-a';
  assert.throws(() => validateAppArchives(input.state, input.sourceProfile), refused);
});
test('archival refuses a generated namespace that overlaps permanently retired data', () => {
  const input = fixture(); input.state.apps.old = { slot: null, route: 'retired', retirement: { previous: { prefix: `archive-generations/${archive}` } } };
  assert.throws(() => projectAppArchive(input), refused);
});

for (const [name, mutate] of [
  ['retained namespace', profile => { profile.fleets[1].prefix = 'empty/replacement'; }],
  ['retained node identity', profile => { profile.fleets[1].nodes[0].id = 'replacement-node'; }],
  ['storage bucket', profile => { profile.bucket = 'other-bucket'; }],
  ['runtime image', profile => { profile.image = 'sha256:' + 'f'.repeat(64); }],
  ['storage image', profile => { profile.storageImage = 'sha256:' + 'f'.repeat(64); }],
  ['runtime family', profile => { profile.family = 'different-family'; }],
]) test(`restored archive state validation refuses a changed ${name}`, () => {
  const input = restoration(), state = projectAppArchiveRestore(input);
  mutate(input.profile);
  assert.throws(() => validateAppArchives(state, input.profile), refused);
});

for (const [name, mutate] of [
  ['namespace', profile => { profile.fleets[1].prefix = 'empty/replacement'; }],
  ['node identity', profile => { profile.fleets[1].nodes[0].id = 'replacement-node'; }],
]) test(`rewriting the target binding cannot authorize a different retained ${name}`, () => {
  const input = restoration(), state = projectAppArchiveRestore(input);
  mutate(input.profile);
  state.appArchives.records[archive].restoration.targetIdentity = runtimePolicyIdentity(input.profile);
  assert.throws(() => validateAppArchives(state, input.profile), refused);
});

test('restored archive state validation refuses a changed target policy binding', () => {
  const input = restoration(), state = projectAppArchiveRestore(input);
  state.appArchives.records[archive].restoration.targetIdentity = '0'.repeat(64);
  assert.throws(() => validateAppArchives(state, input.profile), refused);
});
