import test from 'node:test';
import assert from 'node:assert/strict';
import { startupRouting } from '../src/startup-routing.mjs';
import { runtimePolicyIdentity } from '../src/runtime-policy.mjs';
import { policy } from './fixtures/runtime-policy.mjs';

test('explicit startup derives route identity and slots from the independent native policy', () => {
  const profile = policy(), expected = runtimePolicyIdentity(profile);
  const routing = startupRouting({ path: '/authority/routes.json' }, profile, () => null);
  assert.deepEqual(routing.policy, { installation: expected, slots: ['slot-1', 'slot-2'] });
  assert.equal(routing.path, '/authority/routes.json'); assert.equal(Object.hasOwn(routing, 'fresh'), false); assert.equal(typeof routing.verifyRuntime, 'function');
  profile.fleets[0].nodes[0].id = 'mutated'; assert.equal(routing.policy.installation, expected);
});
for (const input of [{ fresh: true }, { path: '/authority/routes.json', fresh: true }, { path: '/authority/routes.json', fresh: false }, { path: '/authority/routes.json', fresh: 'true' }, { path: '/authority/routes.json', verifyRuntime() {} }, { path: '/authority/routes.json', policy: {} }]) test('startup refuses caller-supplied verification or route identity', () => {
  assert.throws(() => startupRouting(input, policy(), () => null), /Invalid candidate route startup/);
});
test('durable startup cannot select itself without an independent native policy', () => {
  assert.throws(() => startupRouting({ path: '/authority/routes.json' }, null, () => null), { code: 'RUNTIME_POLICY_REFUSED' });
  assert.equal(startupRouting(null, null, () => null), null);
});

for (const path of ['relative/routes.json', '/authority/other.json', '/authority/routes.json/']) test(`startup refuses a mismatched fixed authority path: ${path}`, () => {
  assert.throws(() => startupRouting({ path }, policy(), () => null), /absolute path to routes.json/);
});
