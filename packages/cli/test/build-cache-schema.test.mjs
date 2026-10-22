import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../src/build-cache/schema.mjs';
const id = '00000000-0000-4000-8000-000000000001';
const plan = () => ({ format: 'fogd-host-cache-plan-v1', app: 'sample', home: 'a'.repeat(64), controller: 'b'.repeat(64), rows: [{ app: 'sample', id, decision: 'keep' }] });
for (const [name, mutate] of [
  ['duplicate IDs', value => value.rows.push({ ...value.rows[0] })],
  ['mixed apps', value => { value.rows[0].app = 'other'; }],
  ['path traversal', value => { value.rows[0].id = '../escape'; }],
  ['unknown decision', value => { value.rows[0].decision = 'delete-anything'; }],
  ['missing prune inventory', value => { value.rows[0].decision = 'prune'; }],
  ['unsupported format', value => { value.format = 'future'; }],
  ['unbound controller', value => { value.controller = ''; }],
]) test(`plan schema refuses ${name}`, () => {
  const value = plan(); mutate(value); assert.throws(() => validatePlan(value));
});
test('kept rows require identity but never gain deletion authority from descriptive metadata', () => {
  const value = plan(); value.rows[0].reason = 'terminal-copy'; value.rows[0].logicalBytes = 100;
  assert.doesNotThrow(() => validatePlan(value)); assert.equal(value.rows[0].decision, 'keep');
});
