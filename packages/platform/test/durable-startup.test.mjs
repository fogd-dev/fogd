import test from 'node:test';
import assert from 'node:assert/strict';
import { durableControllerStartup } from '../src/durable-startup.mjs';
import { policy, environment } from './fixtures/runtime-policy.mjs';

const durable = () => ({ ...policy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'] });
test('durable entrypoint requires an independent profile and fixes its authority path', async () => {
  const expected = durable(), env = environment(); let calls = 0;
  const startup = durableControllerStartup(async actual => { assert.equal(actual, env); calls++; return expected; });
  assert.deepEqual(startup.routeAuthority, { path: '/var/lib/fogd-routes/routes.json' });
  assert.deepEqual(await startup.readPolicy(env), expected); assert.equal(calls, 1);
});
for (const [name, value] of [['missing', null], ['legacy', policy()], ['wrong entrypoint', { ...durable(), controllerArgs: ['packages/platform/src/main.mjs'] }],
  ['wrong routing', { ...durable(), routing: 'lookup' }]]) test(`${name} policy cannot select the durable entrypoint`, async () => {
  await assert.rejects(durableControllerStartup(async () => value).readPolicy(environment()), { code: 'RUNTIME_POLICY_REFUSED' });
});
test('durable profile-reader diagnostics are withheld', async () => {
  await assert.rejects(durableControllerStartup(async () => { throw new Error('PRIVATE diagnostics'); }).readPolicy(environment()),
    error => error.code === 'RUNTIME_POLICY_REFUSED' && !error.message.includes('PRIVATE') && !('cause' in error));
});
