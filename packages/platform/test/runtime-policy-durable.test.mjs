import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimePolicy, runtimePolicyIdentity } from '../src/runtime-policy.mjs';
import { policy, environment } from './fixtures/runtime-policy.mjs';

const refused = { code: 'RUNTIME_POLICY_REFUSED' };
const durable = () => ({ ...policy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'] });
const networks = { control: '10.40.0.0/24', 'fleet-1': '10.40.1.0/24', 'fleet-2': '10.40.2.0/24' };

test('legacy schema 2 profile keeps its exact shape', () => {
  assert.deepEqual(validateRuntimePolicy(policy(), environment()), policy());
  assert.deepEqual(validateRuntimePolicy({ ...policy(), networks }).networks, networks);
});

test('durable schema 3 profile validates with the same storage, fleet and network rules', () => {
  assert.deepEqual(validateRuntimePolicy(durable(), environment()), durable());
  assert.deepEqual(validateRuntimePolicy({ ...durable(), networks }).networks, networks);
  assert.throws(() => validateRuntimePolicy(durable(), { ...environment(), FOGD_BUCKET: 'other' }), refused);
});

test('identity hashes storage and fleets only, not execution mode', () => {
  assert.equal(runtimePolicyIdentity(durable()), runtimePolicyIdentity(policy()));
  const moved = durable(); moved.bucket = 'other-bucket';
  assert.notEqual(runtimePolicyIdentity(moved), runtimePolicyIdentity(policy()));
});

for (const [name, make] of [
  ['legacy profile with routing', () => ({ ...policy(), routing: 'durable' })],
  ['legacy profile with durable controller', () => ({ ...policy(), controllerArgs: ['packages/platform/src/main-durable.mjs'] })],
  ['durable profile without routing', () => { const p = durable(); delete p.routing; return p; }],
  ['durable profile with legacy controller', () => ({ ...durable(), controllerArgs: ['packages/platform/src/main.mjs'] })],
  ['durable profile with other routing', () => ({ ...durable(), routing: 'legacy' })],
  ['durable profile with extra controller args', () => ({ ...durable(), controllerArgs: ['packages/platform/src/main-durable.mjs', '--x'] })],
  ['durable profile with foreign field', () => ({ ...durable(), secret: 'x' })],
  ['durable profile missing storage', () => { const p = durable(); delete p.storage; return p; }],
  ['durable profile with one fleet', () => { const p = durable(); p.fleets.pop(); return p; }],
  ['durable profile reusing native identity', () => { const p = durable(); p.fleets[1].nodes[0].id = 'slot-1-a'; return p; }],
  ['durable profile with public network', () => ({ ...durable(), networks: { ...networks, control: '192.168.0.0/24' } })],
  ['string schema', () => ({ ...policy(), schema: '2' })],
  ['schema 4', () => ({ ...durable(), schema: 4 })],
  ['schema 1', () => ({ ...policy(), schema: 1 })],
]) test(`${name} refuses`, () => {
  assert.throws(() => validateRuntimePolicy(make()), refused);
});
