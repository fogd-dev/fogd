import test from 'node:test';
import assert from 'node:assert/strict';
import { releasePlan, selectedRelease, releaseCommand } from '../release/policy.mjs';
import contract from './contract.mjs';
const fixture = () => ({ schema: 2, releases: releasePlan(contract, { old: 'a'.repeat(64), new: 'b'.repeat(64), final: 'c'.repeat(64) }) });
test('replacement authority pins initial source and the exact update order and gate', () => {
  assert.deepEqual(selectedRelease(fixture(), contract, 'old'), { release: 'old', gate: null, digest: 'a'.repeat(64), slot: 'slot-1', dir: '/var/lib/fogd', sourceRoot: '/var/lib/fogd/qualification/artifacts', source: '/var/lib/fogd/qualification/artifacts/old', output: '/var/lib/fogd/qualification/session' });
  assert.equal(selectedRelease(fixture(), contract, 'new', 'old').gate, 'after-migration');
  assert.equal(selectedRelease(fixture(), contract, 'final', 'new').gate, 'before-publication');
  for (const [name, current] of [['new', null], ['final', 'old'], ['old', 'new'], ['final', 'final'], ['constructor', null], ['../old', null], [['old'], null]]) assert.throws(() => selectedRelease(fixture(), contract, name, current), /release|Release/);
});
test('replacement command data cannot choose a source path, gate or skipped release', () => {
  const command = { id: '12345678-1234-1234-1234-123456789abc', operation: 'update', release: 'new' };
  assert.equal(releaseCommand(fixture(), contract, 'old', command).gate, 'after-migration');
  for (const extra of [{ source: '/tmp/worker' }, { updateGate: 'before-publication' }, { release: 'final' }, { operation: 'publish' }]) assert.throws(() => releaseCommand(fixture(), contract, 'old', { ...command, ...extra }), /Release|release|Invalid/);
});
test('replacement refuses changed locations and malformed or inherited pins', () => {
  for (const alter of [p => { p.schema = 1; }, p => { p.releases.slot = 'slot-2'; }, p => { p.releases.dir = '/tmp'; }, p => { p.releases.sourceRoot = '/tmp'; }, p => { p.releases.output = '/app'; }, p => { p.releases.artifacts.old = 'private-invalid'; }, p => { p.releases.artifacts = Object.create({ old: 'a'.repeat(64) }); }]) {
    const policy = fixture(); alter(policy);
    assert.throws(() => selectedRelease(policy, contract, 'old'), { message: /^(Unqualified release|Release location differs)/ });
  }
});
