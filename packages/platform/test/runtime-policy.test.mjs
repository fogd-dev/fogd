import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimePolicy, runtimePolicyIdentity, decodeRuntimePolicy } from '../src/runtime-policy.mjs';

import { policy, environment } from './fixtures/runtime-policy.mjs';

const refused = { code: 'RUNTIME_POLICY_REFUSED', message: 'Installed runtime policy is invalid or does not match this installation' };

test('a bound installation policy is copied before callers can change it', () => {
  const input = policy(), selected = validateRuntimePolicy(input, environment());
  input.fleets[0].nodes[0].id = 'changed';
  assert.equal(selected.fleets[0].nodes[0].id, 'slot-1-a');
  assert.equal(selected.admission, 'candidate');
});

for (const [name, change] of [
  ['unknown schema', input => { input.schema = 1; }],
  ['unknown enrollment state', input => { input.admission = 'enabled'; }],
  ['unqualified launch command', input => { input.controllerArgs = ['/tmp/controller.mjs']; }],
  ['image tag instead of immutable ID', input => { input.image = 'runtime:latest'; }],
  ['malformed native digest', input => { input.binarySha256 = 'candidate'; }],
  ['unexpected credential field', input => { input.secret = 'private-value-must-not-appear'; }],
  ['noncanonical storage origin', input => { input.storage.endpoint = 'http://minio:9000/'; }],
  ['storage URL credentials', input => { input.storage.endpoint = 'http://user:private-value-must-not-appear@minio:9000'; }],
  ['extra storage options', input => { input.storage.credentials = {}; }],
  ['missing fleet', input => { input.fleets.pop(); }],
  ['overlapping namespaces', input => { input.fleets[1].prefix = 'slots/slot-1/child'; }],
  ['foreign replica host', input => { input.fleets[0].nodes[0].host = 'foreign'; }],
  ['reused native identity', input => { input.fleets[1].nodes[0].id = 'slot-1-a'; }],
  ['extra node options', input => { input.fleets[0].nodes[0].command = 'other'; }],
]) test(`${name} refuses installation policy without private diagnostics`, () => {
  const input = policy(); change(input);
  assert.throws(() => validateRuntimePolicy(input), refused);
});

for (const [name, change] of [
  ['another bucket', env => { env.FOGD_BUCKET = 'another-bucket'; }],
  ['another origin', env => { env.S3_ENDPOINT = 'http://foreign:9000'; }],
  ['another region', env => { env.AWS_REGION = 'another-region'; }],
  ['another fleet', env => { env.FOGD_SLOTS = '[]'; }],
  ['missing fleet configuration', env => { delete env.FOGD_SLOTS; }],
  ['swapped fleets', env => { env.FOGD_SLOTS = JSON.stringify(JSON.parse(env.FOGD_SLOTS).reverse()); }],
  ['another prefix', env => { const slots = JSON.parse(env.FOGD_SLOTS); slots[0].prefix = 'another-prefix'; env.FOGD_SLOTS = JSON.stringify(slots); }],
  ['another replica host', env => { const slots = JSON.parse(env.FOGD_SLOTS); slots[0].nodes[0] = 'foreign'; env.FOGD_SLOTS = JSON.stringify(slots); }],
]) test(`${name} refuses a policy bound to the original installation`, () => {
  const env = environment(); change(env);
  assert.throws(() => validateRuntimePolicy(policy(), env), refused);
});
test('the controller storage endpoint may use its equivalent trailing slash', () => {
  const env = environment(); env.S3_ENDPOINT = 'http://minio:9000/';
  assert.equal(validateRuntimePolicy(policy(), env).storage.endpoint, 'http://minio:9000');
});
test('valid JSON at the byte limit decodes as a bound policy', () => {
  const text = JSON.stringify(policy()).padEnd(65536, ' ');
  assert.equal(decodeRuntimePolicy(text, environment()).family, 'celld-cron-r1');
});
test('valid JSON above the byte limit is refused', () => {
  const text = JSON.stringify(policy()).padEnd(65537, ' ');
  assert.throws(() => decodeRuntimePolicy(text, environment()), refused);
});

test('installation identity has a fixed canonical encoding', () => {
  assert.equal(runtimePolicyIdentity(policy()), 'f2df9a691889d54bbb4c9a1f550a1d687c0572cd26f13ef639de4c482d331b5d');
});
test('catalog promotion and image selection do not change installation identity', () => {
  const input = policy(); input.admission = 'qualified'; input.image = 'sha256:'+'e'.repeat(64);
  assert.equal(runtimePolicyIdentity(input), 'f2df9a691889d54bbb4c9a1f550a1d687c0572cd26f13ef639de4c482d331b5d');
});
test('installation identity ignores JSON property order', () => {
  const input = policy(); input.storage = { region: 'us-east-1', endpoint: 'http://minio:9000' };
  input.fleets[0] = { nodes: [{ id: 'slot-1-a', host: 'slot-1-a' }, { id: 'slot-1-b', host: 'slot-1-b' }], prefix: 'slots/slot-1', id: 'slot-1' };
  assert.equal(runtimePolicyIdentity(input), 'f2df9a691889d54bbb4c9a1f550a1d687c0572cd26f13ef639de4c482d331b5d');
});

test('explicit private launch networks are validated without changing storage installation identity', () => {
  const input = policy();
  input.networks = { control: '10.253.180.0/24', 'fleet-1': '10.253.181.0/24', 'fleet-2': '10.253.182.0/24' };
  assert.deepEqual(validateRuntimePolicy(input, environment()), input);
  assert.equal(runtimePolicyIdentity(input), 'f2df9a691889d54bbb4c9a1f550a1d687c0572cd26f13ef639de4c482d331b5d');
  for (const networks of [null, {}, { ...input.networks, extra: '10.253.183.0/24' },
    { ...input.networks, control: input.networks['fleet-1'] }, { ...input.networks, control: '192.168.10.0/24' },
    { ...input.networks, control: '10.253.180.0/16' }, { ...input.networks, control: '10.253.180.1/24' }]) {
    assert.throws(() => validateRuntimePolicy({ ...input, networks }), refused);
  }
});
