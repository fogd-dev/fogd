import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedBackend } from '../src/startup.mjs';
import { Backend } from '../src/backend.mjs';
import { policy, environment } from './fixtures/runtime-policy.mjs';

const env = () => ({ ...environment(), AWS_ACCESS_KEY_ID: 'synthetic-access', AWS_SECRET_ACCESS_KEY: 'synthetic-secret' });

test('an absent policy preserves an explicitly supplied backend', () => {
  const supplied = { source: 'caller' };
  assert.equal(selectedBackend(supplied, null, env()), supplied);
});
test('an absent policy constructs a backend without cron transport', t => {
  const selected = selectedBackend(undefined, null, env()); t.after(() => selected.s3.destroy());
  assert.ok(selected instanceof Backend);
  assert.equal(selected.crons, undefined);
  assert.equal(selected.env.FOGD_BUCKET, 'fogd');
});
test('an installed policy constructs a guarded backend that refuses foreign fleets', async t => {
  const selected = selectedBackend(undefined, policy(), env()); t.after(() => selected.s3.destroy());
  selected.run = async () => { throw new Error('Native CLI must not run for an undeclared fleet'); };
  assert.equal(typeof selected.crons.verify, 'function');
  assert.equal(typeof selected.crons.verifyBootstrap, 'function');
  await assert.rejects(selected.crons.status({ id: 'foreign', prefix: 'foreign', nodes: ['foreign-a', 'foreign-b'] }, 'refresh'), { code: 'CRON_RUNTIME_UNVERIFIED' });
});
test('an installed policy refuses a conflicting injected backend', () => {
  assert.throws(() => selectedBackend({}, policy(), env()), { message: 'Injected backend conflicts with installed runtime policy' });
});
test('a malformed policy cannot select a backend', () => {
  const input = policy(); input.schema = 1;
  assert.throws(() => selectedBackend(undefined, input, env()), { code: 'RUNTIME_POLICY_REFUSED' });
});
test('a policy cannot select a backend without an environment binding', () => {
  assert.throws(() => selectedBackend(undefined, policy()), { code: 'RUNTIME_POLICY_REFUSED' });
});
