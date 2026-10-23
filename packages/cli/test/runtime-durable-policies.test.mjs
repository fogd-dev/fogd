import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { durableRuntimeConfig } from '../src/runtime/durable-config.mjs';
import { installDurablePolicies } from '../src/runtime/durable-policies.mjs';
import { freshRuntimePlan, runtimePolicyForConfig } from '../src/runtime/selection-plan.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

function fixture() {
  const { source, profile } = prebootFixture();
  const entry = { ...profile, id: 'celld-cron-v2-linux-arm64', admission: 'candidate', routing: 'durable' };
  const plan = freshRuntimePlan(source, entry), policy = runtimePolicyForConfig(plan.config, entry);
  const config = durableRuntimeConfig(plan.config, policy);
  const gateway = { schema: 1, policy: { installation: runtimePolicyIdentity(policy), slots: ['slot-1', 'slot-2'] },
    slots: ['slot-1', 'slot-2'].map(id => ({ id, nodes: [`${id}-a`, `${id}-b`] })) };
  const runtimeReceipt = { family: policy.family, admission: policy.admission, identitySha256: runtimePolicyIdentity(policy) };
  const gatewayReceipt = { installation: gateway.policy.installation, sha256: createHash('sha256').update(JSON.stringify(gateway) + '\n').digest('hex') };
  return { config, policy, gateway, runtimeReceipt, gatewayReceipt };
}

function helpers(f, outputs = [f.runtimeReceipt, f.gatewayReceipt, f.gateway], readback = f.policy) {
  const calls = [], reads = [];
  return { calls, reads,
    readVolume: async (...args) => {
      calls.push(args);
      const output = outputs[calls.length - 1];
      if (output instanceof Error) throw output;
      return typeof output === 'string' ? output : JSON.stringify(output) + '\n';
    },
    readPolicy: async (...args) => { reads.push(args); if (readback instanceof Error) throw readback; return structuredClone(readback); } };
}

async function refused(promise) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'DURABLE_POLICIES_REFUSED');
    assert.doesNotMatch(error.message + String(error.stack), /private|sha256:|minio/);
    return true;
  });
}

test('installs runtime then gateway policy create-only with fixed code, volumes, no caps and nonsecret input', async () => {
  const f = fixture(), h = helpers(f);
  assert.deepEqual(await installDurablePolicies(f.config, f.policy, h), { runtime: f.runtimeReceipt, gateway: f.gatewayReceipt });
  assert.equal(h.calls.length, 3);
  const [[rImage, rVolume, rArgs, rOptions], [wImage, wVolume, wArgs, wOptions], [gImage, gVolume, gArgs, gOptions]] = h.calls;
  for (const image of [rImage, wImage, gImage]) assert.equal(image, f.policy.image);
  assert.equal(rVolume, 'original_runtime-policy');
  assert.equal(wVolume, 'original_gateway-policy'); assert.equal(gVolume, 'original_gateway-policy');
  assert.deepEqual(rArgs, ['packages/platform/src/import-fresh-runtime-policy.mjs']);
  assert.deepEqual(rOptions, { readonly: false, entrypoint: '/usr/local/bin/node', capabilities: [], inputText: JSON.stringify(f.policy) });
  assert.deepEqual(wOptions, { readonly: false, entrypoint: '/usr/local/bin/node', capabilities: [], inputText: JSON.stringify(f.gateway) });
  assert.deepEqual(gOptions, { readonly: true, entrypoint: '/usr/local/bin/node', capabilities: [] });
  assert.match(wArgs[2], /\.\/packages\/runtime\/src\/gateway-launch-policy\.mjs'.*writeGatewayLaunchPolicy\('\/data'/);
  assert.match(gArgs[2], /readGatewayLaunchPolicy\('\/data'\)/);
  assert.deepEqual(h.reads, [[f.policy.image, 'original_runtime-policy', f.config.services.controller.environment]]);
  assert.doesNotMatch(JSON.stringify(h.calls), /AWS_SECRET|PASSWORD|TOKEN|\/Users|\.fogd/);
});

test('profile and sealed config must match exactly and be durable schema 3', async () => {
  const f = fixture();
  const legacy = { ...f.policy, schema: 2, controllerArgs: ['packages/platform/src/main.mjs'] }; delete legacy.routing;
  for (const [config, profile] of [
    [{ ...f.config, volumes: { ...f.config.volumes, 'gateway-policy': { name: 'foreign' } } }, f.policy],
    [{ ...f.config, volumes: { ...f.config.volumes, 'runtime-policy': { name: 'foreign' } } }, f.policy],
    [f.config, { ...f.policy, image: 'sha256:' + 'f'.repeat(64) }],
    [f.config, legacy],
    [f.config, null],
  ]) {
    const h = helpers(f);
    await refused(installDurablePolicies(config, profile, h));
    assert.equal(h.calls.length + h.reads.length, 0);
  }
});

test('runtime receipt or readback mismatch never starts the gateway writer', async () => {
  const f = fixture();
  const other = { ...f.runtimeReceipt, admission: 'qualified' };
  for (const [output, readback] of [[other, f.policy], [{ ...f.runtimeReceipt, extra: 1 }, f.policy], ['x'.repeat(2000), f.policy],
    [new Error('docker failed: private'), f.policy], [f.runtimeReceipt, { ...f.policy, admission: 'qualified' }], [f.runtimeReceipt, new Error('private')]]) {
    const h = helpers(f, [output, f.gatewayReceipt, f.gateway], readback);
    await refused(installDurablePolicies(f.config, f.policy, h));
    assert.equal(h.calls.length, 1);
  }
});

test('gateway receipt and readback must equal the independently derived plan', async () => {
  const f = fixture();
  const foreign = structuredClone(f.gateway); foreign.policy.installation = 'f'.repeat(64);
  for (const [outputs, count] of [
    [[f.runtimeReceipt, { ...f.gatewayReceipt, sha256: '0'.repeat(64) }, f.gateway], 2],
    [[f.runtimeReceipt, { ...f.gatewayReceipt, path: '/data' }, f.gateway], 2],
    [[f.runtimeReceipt, new Error('exists'), f.gateway], 2],
    [[f.runtimeReceipt, f.gatewayReceipt, foreign], 3],
    [[f.runtimeReceipt, f.gatewayReceipt, { ...f.gateway, slots: [...f.gateway.slots].reverse() }], 3],
    [[f.runtimeReceipt, f.gatewayReceipt, JSON.stringify(f.gateway).padEnd(16 * 1024 + 1)], 3],
    [[f.runtimeReceipt, f.gatewayReceipt, '{"schema":1,"x":"é"}\n'], 3],
  ]) {
    const h = helpers(f, outputs);
    await refused(installDurablePolicies(f.config, f.policy, h));
    assert.equal(h.calls.length, count);
  }
});
