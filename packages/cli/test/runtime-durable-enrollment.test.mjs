import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { encodeRouteRecord } from '@fogd/runtime/route-record';
import { durableRuntimeConfig } from '../src/runtime/durable-config.mjs';
import { initializeDurableRoutes } from '../src/runtime/durable-enrollment.mjs';
import { freshRuntimePlan, runtimePolicyForConfig } from '../src/runtime/selection-plan.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

const binding = 'b'.repeat(64), id = '01234567-89ab-4def-8123-456789abcdef';
function fixture() {
  const { source, profile } = prebootFixture();
  const entry = { ...profile, id: 'celld-cron-v2-linux-arm64', admission: 'candidate', routing: 'durable' };
  const plan = freshRuntimePlan(source, entry), policy = runtimePolicyForConfig(plan.config, entry);
  const config = durableRuntimeConfig(plan.config, policy), installation = runtimePolicyIdentity(policy);
  const empty = encodeRouteRecord({ schema: 1, installation, revision: '0', routes: [] }, { installation, slots: ['slot-1', 'slot-2'] });
  const receipt = { id, installation, binding, revision: '0', sha256: createHash('sha256').update(empty).digest('hex') };
  return { config, policy, receipt };
}
function runner(output) {
  const calls = [];
  return { calls, run: async (...args) => { calls.push(args); if (output instanceof Error) throw output; return output; } };
}
const generic = code => error => error.code === code && !('cause' in error) && !/private|sha256:|PRIVATE/.test(error.message);

test('the dedicated initializer runs isolated with exactly the three role volumes and returns the checked receipt', async () => {
  const f = fixture(), r = runner(JSON.stringify(f.receipt) + '\n');
  assert.deepEqual(await initializeDurableRoutes(f.config, f.policy, binding, r), f.receipt);
  assert.equal(r.calls.length, 1);
  const [args, options] = r.calls[0], name = role => f.config.volumes[role].name;
  assert.deepEqual(args, ['run', '--pull', 'never', '--rm', '-i', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,src=${name('controller')},dst=/var/lib/fogd,volume-nocopy`,
    '--mount', `type=volume,src=${name('route-authority')},dst=/var/lib/fogd-routes,volume-nocopy`,
    '--mount', `type=volume,src=${name('route-enrollment')},dst=/var/lib/fogd-enrollment,volume-nocopy`,
    '--entrypoint', '/usr/local/bin/node', f.policy.image, 'packages/platform/src/import-route-enrollment.mjs']);
  assert.deepEqual(Object.keys(options), ['inputText']);
  assert.deepEqual(JSON.parse(options.inputText), { profile: f.policy, binding });
  assert.doesNotMatch(args.join(' ') + options.inputText, /--cap-add|type=bind|PASSWORD|TOKEN|tls|AWS_SECRET/);
});

for (const [name, change] of [
  ['short binding', f => { f.binding = 'b'.repeat(63); }],
  ['legacy profile', f => { f.policy = { ...f.policy, schema: 2 }; }],
  ['drifted config', f => { f.config.services.controller.volumes.push({ type: 'bind', source: '/srv', target: '/srv' }); }],
  ['unsealed image', f => { f.policy = { ...f.policy, image: `sha256:${'9'.repeat(64)}` }; }],
]) test(`${name} refuses before running any command`, async () => {
  const f = { ...fixture(), binding }, r = runner(''); change(f);
  await assert.rejects(initializeDurableRoutes(f.config, f.policy, f.binding, r), generic('DURABLE_ENROLLMENT_REFUSED'));
  assert.equal(r.calls.length, 0);
});

for (const [name, tamper] of [
  ['revision', receipt => ({ ...receipt, revision: '1' })],
  ['digest', receipt => ({ ...receipt, sha256: 'e'.repeat(64) })],
  ['installation', receipt => ({ ...receipt, installation: 'f'.repeat(64) })],
  ['binding', receipt => ({ ...receipt, binding: 'c'.repeat(64) })],
  ['id', receipt => ({ ...receipt, id: 'not-a-uuid' })],
  ['extra field', receipt => ({ ...receipt, private: 'PRIVATE' })],
  ['missing field', ({ sha256, ...receipt }) => receipt],
  ['oversized output', receipt => ({ ...receipt, pad: ' '.repeat(2048) })],
  ['non-ASCII output', () => '{"id":"é"}'],
  ['empty output', () => ''],
]) test(`tampered receipt ${name} is uncertain without causes`, async () => {
  const f = fixture(), value = tamper(f.receipt), r = runner(typeof value === 'string' ? value : JSON.stringify(value));
  await assert.rejects(initializeDurableRoutes(f.config, f.policy, binding, r), generic('DURABLE_ENROLLMENT_UNCERTAIN'));
});

test('a failed helper command is uncertain and hides its diagnostics', async () => {
  const f = fixture();
  await assert.rejects(initializeDurableRoutes(f.config, f.policy, binding, runner(new Error('PRIVATE docker failure'))), generic('DURABLE_ENROLLMENT_UNCERTAIN'));
});
