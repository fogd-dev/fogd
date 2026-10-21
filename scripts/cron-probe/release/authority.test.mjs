import test from 'node:test';
import assert from 'node:assert/strict';
import { activeRelease, releasePlan } from './policy.mjs';
import contract from '../faults/contract.mjs';
const policy = () => ({ schema: 2, releases: releasePlan(contract, { fast: 'a'.repeat(64), sparse: 'b'.repeat(64) }) });
const completed = (id, digest, status, submittedAt) => ({ id, app: 'refresh', step: 'complete', digest, status, submittedAt });

test('the first fast approval is the initial release', () => {
  assert.equal(activeRelease(policy(), contract, { apps: { refresh: { active: 'first' } }, deployments: { first: completed('first', 'a'.repeat(64), 'active', '2026-10-21T00:00:00.000Z') } }), 'fast');
});
test('durable approval order distinguishes the final fast approval from the same initial digest', () => {
  assert.equal(activeRelease(policy(), contract, { apps: { refresh: { active: 'last' } }, deployments: {
    first: completed('first', 'a'.repeat(64), 'superseded', '2026-10-21T00:00:00.000Z'),
    middle: completed('middle', 'b'.repeat(64), 'superseded', '2026-10-21T00:01:00.000Z'),
    last: completed('last', 'a'.repeat(64), 'active', '2026-10-21T00:02:00.000Z'),
  } }), 'final');
});
test('a fourth completed approval is outside the immutable sequence', () => {
  assert.throws(() => activeRelease(policy(), contract, { apps: { refresh: { active: 'extra' } }, deployments: {
    first: completed('first', 'a'.repeat(64), 'superseded', '2026-10-21T00:00:00.000Z'),
    middle: completed('middle', 'b'.repeat(64), 'superseded', '2026-10-21T00:01:00.000Z'),
    last: completed('last', 'a'.repeat(64), 'superseded', '2026-10-21T00:02:00.000Z'),
    extra: completed('extra', 'b'.repeat(64), 'active', '2026-10-21T00:03:00.000Z'),
  } }), /Release approvals exceed/);
});

test('equal approval timestamps are ambiguous', () => {
  assert.throws(() => activeRelease(policy(), contract, { apps: { refresh: { active: 'middle' } }, deployments: {
    first: completed('first', 'a'.repeat(64), 'superseded', '2026-10-21T00:00:00.000Z'),
    middle: completed('middle', 'b'.repeat(64), 'active', '2026-10-21T00:00:00.000Z'),
  } }), /ambiguous/);
});
test('completed digests must follow the immutable order', () => {
  assert.throws(() => activeRelease(policy(), contract, { apps: { refresh: { active: 'first' } }, deployments: {
    first: completed('first', 'b'.repeat(64), 'active', '2026-10-21T00:00:00.000Z'),
  } }), /immutable release sequence/);
});
test('active request must be the latest completed approval', () => {
  assert.throws(() => activeRelease(policy(), contract, { apps: { refresh: { active: 'first' } }, deployments: {
    first: completed('first', 'a'.repeat(64), 'superseded', '2026-10-21T00:00:00.000Z'),
    middle: completed('middle', 'b'.repeat(64), 'active', '2026-10-21T00:01:00.000Z'),
  } }), /latest completed approval/);
});
test('incomplete superseded and failed requests do not advance authority', () => {
  assert.equal(activeRelease(policy(), contract, { apps: { refresh: { active: 'first' } }, deployments: {
    first: completed('first', 'a'.repeat(64), 'active', '2026-10-21T00:00:00.000Z'),
    incomplete: { ...completed('incomplete', 'b'.repeat(64), 'superseded', '2026-10-21T00:01:00.000Z'), step: 'publish' },
    failed: completed('failed', 'b'.repeat(64), 'failed', '2026-10-21T00:02:00.000Z'),
  } }), 'fast');
});
