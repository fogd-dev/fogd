import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../platform/src/controller.mjs';
import { assertLiveName } from '../../platform/src/retirement.mjs';
import { compareCandidate } from '../src/doctor/compatibility.mjs';

const authority = { Controller, assertLiveName }, capabilities = { cronApps: true, queueApps: true };
const resources = { script: 'demo', d1: [{ binding: 'DB', database_id: 'demo-db' }], r2: [{ binding: 'FILES', bucket_name: 'demo-files' }], durable: { bindings: [] } };
const migration = { database: 'demo-db', name: '0001_create.sql', digest: 'a'.repeat(64) };
const candidate = () => ({ app: 'demo', resources: structuredClone(resources), migrations: [migration] });
function retained() {
  return { apps: { demo: { active: 'old', resources: structuredClone(resources), migrations: [migration] } },
    deployments: { old: { app: 'demo', resources: structuredClone(resources) } } };
}
const compare = (state, release = candidate(), caps = capabilities) => compareCandidate(state, release, caps, authority);

test('new app comparison reports additions and pending migrations without changing inputs', () => {
  const state = { apps: {}, deployments: {} }, release = candidate(), before = structuredClone({ state, release });
  assert.deepEqual(compare(state, release), { status: 'supported', reason: 'compatible', existingApp: false, r2Added: 1, appliedMigrations: 0, pendingMigrations: 1 });
  assert.deepEqual({ state, release }, before);
});
test('existing app comparison reports only new R2 bindings and unapplied migrations', () => {
  const state = retained(), release = candidate(), before = structuredClone(state);
  release.resources.r2.push({ binding: 'EXTRA', bucket_name: 'demo-extra' });
  release.migrations.push({ ...migration, name: '0002_more.sql', digest: 'b'.repeat(64) });
  assert.deepEqual(compare(state, release), { status: 'supported', reason: 'compatible', existingApp: true, r2Added: 1, appliedMigrations: 1, pendingMigrations: 1 });
  assert.deepEqual(state, before);
});
test('resources retained after failed activation remain a floor beyond the active release', () => {
  const state = retained(); state.apps.demo.resources.r2.push({ binding: 'FAILED', bucket_name: 'demo-failed' });
  assert.deepEqual(compare(state), { status: 'unsupported', reason: 'resource-identity' });
});
for (const [name, change, reason] of [
  ['removed D1 binding', release => { release.resources.d1 = []; }, 'resource-identity'],
  ['removed applied migration', release => { release.migrations = []; }, 'migration-history'],
  ['changed applied migration', release => { release.migrations = [{ ...migration, digest: 'c'.repeat(64) }]; }, 'migration-history'],
  ['added cron dispatch', release => { release.resources.crons = ['* * * * *']; }, 'cron-transition'],
]) test(`comparison rejects ${name} with a private-safe reason`, () => {
  const release = candidate(); change(release);
  assert.deepEqual(compare(retained(), release), { status: 'unsupported', reason });
});
test('quarantined and retired names remain refused without exposing private reasons', () => {
  const state = retained(); state.apps.demo.quarantined = true; state.apps.demo.reason = 'private-failure-detail';
  assert.deepEqual(compare(state), { status: 'unsupported', reason: 'quarantined' });
  state.apps.demo.retirement = { private: 'private-record' };
  assert.deepEqual(compare(state), { status: 'unsupported', reason: 'retired' });
});
for (const [resource, capability, reason] of [['queues', 'queueApps', 'queue-admission'], ['crons', 'cronApps', 'cron-admission']]) {
  test(`comparison retains ${resource} admission refusal`, () => {
    const release = candidate(); release.resources[resource] = resource === 'crons' ? ['* * * * *'] : { producers: [], consumers: [] };
    assert.deepEqual(compare({ apps: {}, deployments: {} }, release, { ...capabilities, [capability]: false }), { status: 'unsupported', reason });
  });
}
test('unreadable or incomplete controller structures cannot report compatibility', () => {
  const missingActive = retained(); delete missingActive.deployments.old;
  const wrongApp = retained(); wrongApp.deployments.old.app = 'another';
  const badResources = retained(); badResources.apps.demo.resources = {};
  for (const state of [null, {}, { apps: [], deployments: {} }, { apps: { demo: null }, deployments: {} }, missingActive, wrongApp, badResources]) {
    assert.deepEqual(compare(state), { status: 'unverified', reason: 'state' });
  }
});
