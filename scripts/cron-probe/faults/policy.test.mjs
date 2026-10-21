import test from 'node:test';
import assert from 'node:assert/strict';
import { releasePlan, selectedRelease, releaseCommand } from '../release/policy.mjs';
import contract from './contract.mjs';
const fixture = () => ({ schema: 2, releases: releasePlan(contract, { fast: 'a'.repeat(64), sparse: 'b'.repeat(64) }) });

test('failure authority permits only the fixed minute, sparse and final sequence without publication gates', () => {
  assert.deepEqual(selectedRelease(fixture(), contract, 'fast'), { release: 'fast', gate: null, digest: 'a'.repeat(64), slot: 'slot-1', dir: '/var/lib/fogd', sourceRoot: '/var/lib/fogd/qualification/artifacts', source: '/var/lib/fogd/qualification/artifacts/fast', output: '/var/lib/fogd/qualification/session' });
  assert.equal(selectedRelease(fixture(), contract, 'sparse', 'fast').gate, null);
  assert.equal(selectedRelease(fixture(), contract, 'final', 'sparse').digest, 'a'.repeat(64));
  assert.throws(() => selectedRelease(fixture(), contract, 'fast', 'fast'), /Release order/);
  assert.throws(() => selectedRelease(fixture(), contract, 'sparse', 'final'), /Release order/);
});
test('failure commands cannot choose mutable paths, gates or schedules', () => {
  const command = { id: '12345678-1234-1234-1234-123456789abc', operation: 'update', release: 'sparse' };
  assert.equal(releaseCommand(fixture(), contract, 'fast', command).source, '/var/lib/fogd/qualification/artifacts/sparse');
  for (const extra of [{ source: '/tmp/worker' }, { updateGate: 'after-migration' }, { cron: '* * * * *' }, { release: 'fast' }]) assert.throws(() => releaseCommand(fixture(), contract, 'fast', { ...command, ...extra }), /Release|release/);
});
test('failure authority refuses another profile even for a pause command', () => {
  assert.throws(() => releaseCommand({ schema: 2, releases: { ...fixture().releases, kind: 'replacement' } }, contract, 'fast', { id: '12345678-1234-1234-1234-123456789abc', operation: 'pause' }), /Unqualified release policy/);
});
test('failure artifact authority refuses missing and ambiguous release names', () => {
  assert.throws(() => releasePlan(contract, { fast: 'a'.repeat(64) }), /Unqualified release artifact names/);
  assert.throws(() => releasePlan(contract, { fast: 'a'.repeat(64), sparse: 'a'.repeat(64) }), /Unqualified duplicate release artifact/);
});
test('release command ids must be strings', () => {
  assert.throws(() => releaseCommand(fixture(), contract, 'fast', { id: ['12345678-1234-1234-1234-123456789abc'], operation: 'pause' }), /Invalid release command/);
});
