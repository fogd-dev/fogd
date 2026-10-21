import test from 'node:test';
import assert from 'node:assert/strict';
import { replacementPlan, replacementRelease, replacementCommand } from './policy.mjs';
const fixture = () => ({ schema: 2, replacement: replacementPlan({ old: 'a'.repeat(64), new: 'b'.repeat(64), final: 'c'.repeat(64) }) });
test('replacement authority pins initial source and the exact update order and gate', () => {
  assert.deepEqual(replacementRelease(fixture(), 'old'), { release: 'old', gate: null, digest: 'a'.repeat(64), slot: 'slot-1', dir: '/var/lib/fogd', sourceRoot: '/var/lib/fogd/qualification/artifacts', source: '/var/lib/fogd/qualification/artifacts/old', output: '/var/lib/fogd/qualification/session' });
  assert.equal(replacementRelease(fixture(), 'new', 'old').gate, 'after-migration');
  assert.equal(replacementRelease(fixture(), 'final', 'new').gate, 'before-publication');
  for (const [name, current] of [['new', null], ['final', 'old'], ['old', 'new'], ['final', 'final'], ['constructor', null], ['../old', null], [['old'], null]]) assert.throws(() => replacementRelease(fixture(), name, current), /replacement|Replacement/);
});
test('replacement command data cannot choose a source path, gate or skipped release', () => {
  const command = { id: '12345678-1234-1234-1234-123456789abc', operation: 'update', release: 'new' };
  assert.equal(replacementCommand(fixture(), 'old', command).gate, 'after-migration');
  for (const extra of [{ source: '/tmp/worker' }, { updateGate: 'before-publication' }, { release: 'final' }, { operation: 'publish' }]) assert.throws(() => replacementCommand(fixture(), 'old', { ...command, ...extra }), /Replacement|replacement|Invalid/);
});
test('replacement refuses changed locations and malformed or inherited pins', () => {
  for (const alter of [p => { p.schema = 1; }, p => { p.replacement.slot = 'slot-2'; }, p => { p.replacement.dir = '/tmp'; }, p => { p.replacement.sourceRoot = '/tmp'; }, p => { p.replacement.output = '/app'; }, p => { p.replacement.artifacts.old = 'private-invalid'; }, p => { p.replacement.artifacts = Object.create({ old: 'a'.repeat(64) }); }]) {
    const policy = fixture(); alter(policy);
    assert.throws(() => replacementRelease(policy, 'old'), { message: /^(Unqualified replacement|Replacement location differs)/ });
  }
});
