import test from 'node:test';
import assert from 'node:assert/strict';
import { capacity } from '../src/capacity.mjs';

test('capacity retains paused, quarantined and map-only ownership without exposing backend configuration', () => {
  const controller = {
    slots: ['active', 'paused', 'quarantined', 'orphan', 'empty'].map(id => ({ id, prefix: 'private-prefix', nodes: ['private-address'] })),
    occupied: new Set(['active', 'orphan']), bucketOwners: new Map([['active', 'first'], ['orphan', 'first']]),
    state: { apps: {
      first: { slot: 'active', route: 'active' },
      second: { slot: 'paused', route: 'paused' },
      third: { slot: 'quarantined', route: 'paused', quarantined: true },
      duplicate: { slot: 'quarantined', route: 'paused', quarantined: true },
    }, deployments: {} },
    maxPending: 20, maxPendingPerCredential: 5,
    quota: { describe: () => ({ retainedArtifactBytes: 128, maxArtifactBytes: 1024 }) },
  };
  const before = structuredClone(controller.state);
  const result = capacity(controller);
  assert.equal(result.slots.configured, 5);
  assert.equal(result.slots.occupied, 4);
  assert.equal(result.slots.available, 1);
  assert.equal(result.slots.items.find(s => s.id === 'quarantined').assignments.length, 2);
  assert.deepEqual(result.slots.items.find(s => s.id === 'orphan'), { id: 'orphan', bucketOwner: 'first', occupied: true, assignments: [] });
  assert.ok(!JSON.stringify(result).includes('private-'));
  assert.deepEqual(controller.state, before);
  assert.deepEqual(capacity(controller), result);
});

test('pending capacity counts failed attempts and identifies legacy exemption without reserving slots', () => {
  const controller = {
    slots: [{ id: 'unused' }], occupied: new Set(), bucketOwners: new Map(),
    state: { apps: {}, deployments: Object.fromEntries(['pending', 'failed', 'active', 'superseded', 'rejected'].map(status => [status, { status, submitter: 'builder' }])) },
    maxPending: 3, maxPendingPerCredential: 2,
    quota: { describe: () => ({ retainedArtifactBytes: 1024, maxArtifactBytes: 1024 }) },
  };
  controller.state.deployments.legacy = { status: 'pending', submitter: 'team-token' };
  const result = capacity(controller);
  assert.equal(result.slots.available, 1);
  assert.deepEqual(result.submissions, { pending: 3, limit: 3, perCredentialLimit: 2, byCredential: [
    { id: 'builder', pending: 2, limit: 2 }, { id: 'team-token', pending: 1, limit: null },
  ] });
  assert.equal(result.artifacts.retainedArtifactBytes, 1024);
  assert.match(result.artifacts.accounting, /excludes application data/);
});
