import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRouteRecord, encodeRouteRecord } from '../src/route-record.mjs';

const policy = { installation: 'a'.repeat(64), slots: ['slot-1', 'slot-2'] };
const active = () => ({ host: 'alpha.localhost', state: 'active', slot: 'slot-1', submission: '00000000-0000-4000-8000-000000000001', digest: 'b'.repeat(64) });
const record = () => ({ schema: 1, installation: 'a'.repeat(64), revision: '1', routes: [active(), { host: 'beta.localhost', state: 'withheld', slot: 'slot-2' }] });

test('route record preserves approved identity and a distinct withheld fleet', () => {
  assert.deepEqual(decodeRouteRecord(JSON.stringify(record()), policy), record());
});
test('encoding canonicalizes object keys without changing route decisions', () => {
  const value = record();
  const reordered = { routes: value.routes, revision: value.revision, installation: value.installation, schema: value.schema };
  assert.equal(encodeRouteRecord(reordered, policy), JSON.stringify(value, null, 2));
});
test('initial authority is an empty table in revision zero', () => {
  const value = { schema: 1, installation: 'a'.repeat(64), revision: '0', routes: [] };
  assert.deepEqual(decodeRouteRecord(JSON.stringify(value), policy), value);
});
test('revision preserves the largest unsigned 64-bit value as a string', () => {
  const value = { ...record(), revision: '18446744073709551615' };
  assert.equal(decodeRouteRecord(JSON.stringify(value), policy).revision, '18446744073709551615');
});
for (const [name, patch] of [
  ['foreign installation', { installation: 'c'.repeat(64) }], ['wrong schema', { schema: 2 }],
  ['numeric revision', { revision: 1 }], ['leading zero', { revision: '01' }],
  ['negative revision', { revision: '-1' }], ['revision overflow', { revision: '18446744073709551616' }],
  ['active revision zero', { revision: '0' }], ['unknown field', { password: 'private-do-not-print' }],
  ['non-array routes', { routes: {} }],
]) test(`route record refuses ${name}`, () => {
  assert.throws(() => decodeRouteRecord(JSON.stringify({ ...record(), ...patch }), policy), { message: 'Invalid route authority record' });
});
for (const [name, patch] of [
  ['unknown fleet', { slot: 'slot-3' }], ['unknown state', { state: 'retired' }],
  ['missing approval', { submission: null }], ['noncanonical approval', { submission: '00000000-0000-4000-8000-00000000000Z' }],
  ['bad digest', { digest: 'private-do-not-print' }], ['extra data', { secret: 'private-do-not-print' }],
  ['uppercase host', { host: 'Alpha.localhost' }], ['host with port', { host: 'alpha.localhost:8787' }],
  ['noncanonical IP host', { host: '127.1' }], ['host with path', { host: 'alpha.localhost/path' }], ['host with empty label', { host: 'alpha..localhost' }],
  ['host with invalid label', { host: '-alpha.localhost' }], ['host with long label', { host: 'a'.repeat(64) + '.localhost' }],
]) test(`active route refuses ${name}`, () => {
  assert.throws(() => decodeRouteRecord(JSON.stringify({ ...record(), routes: [{ ...active(), ...patch }] }), policy), { message: 'Invalid route authority record' });
});
for (const [name, routes] of [
  ['duplicate host', [active(), { host: 'alpha.localhost', state: 'withheld', slot: 'slot-2' }]],
  ['duplicate fleet', [active(), { host: 'beta.localhost', state: 'withheld', slot: 'slot-1' }]],
  ['unsorted hosts', [{ host: 'beta.localhost', state: 'withheld', slot: 'slot-2' }, active()]],
  ['withheld approval data', [{ host: 'alpha.localhost', state: 'withheld', slot: 'slot-1', digest: 'b'.repeat(64) }]],
]) test(`route table refuses ${name}`, () => {
  assert.throws(() => decodeRouteRecord(JSON.stringify({ ...record(), routes }), policy), { message: 'Invalid route authority record' });
});
for (const value of ['not-json', JSON.stringify(record()).padEnd(65537, ' '), null]) test(`unreadable or oversized input refuses (${typeof value})`, () => {
  assert.throws(() => decodeRouteRecord(value, policy), { message: 'Invalid route authority record' });
});
for (const value of [{}, { ...policy, slots: [] }, { ...policy, slots: ['slot-1', 'slot-1'] }]) test('missing or ambiguous installed policy refuses', () => {
  assert.throws(() => decodeRouteRecord(JSON.stringify(record()), value), { message: 'Invalid route authority policy' });
});

test('the exact text-size bound accepts a valid padded record', () => {
  const text = JSON.stringify(record()).padEnd(65536, ' ');
  assert.deepEqual(decodeRouteRecord(text, policy), record());
});
