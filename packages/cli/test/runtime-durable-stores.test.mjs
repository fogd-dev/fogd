import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { encodeRouteRecord } from '@fogd/runtime/route-record';
import { durableRuntimeConfig } from '../src/runtime/durable-config.mjs';
import { readDurableStores } from '../src/runtime/durable-stores.mjs';
import { freshRuntimePlan, runtimePolicyForConfig } from '../src/runtime/selection-plan.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

function fixture() {
  const { source, profile } = prebootFixture();
  const entry = { ...profile, id: 'celld-cron-v2-linux-arm64', admission: 'candidate', routing: 'durable' };
  const plan = freshRuntimePlan(source, entry), policy = runtimePolicyForConfig(plan.config, entry);
  const config = durableRuntimeConfig(plan.config, policy);
  const routePolicy = { installation: runtimePolicyIdentity(policy), slots: ['slot-1', 'slot-2'] };
  const gateway = { schema: 1, policy: routePolicy, slots: ['slot-1', 'slot-2'].map(id => ({ id, nodes: [`${id}-a`, `${id}-b`] })) };
  const record = { schema: 1, installation: routePolicy.installation, revision: '3', routes: [
    { host: 'app.example.com', state: 'active', slot: 'slot-1', submission: '01234567-89ab-cdef-0123-456789abcdef', digest: 'e'.repeat(64) },
  ] };
  const canonical = encodeRouteRecord(record, routePolicy);
  const report = { record, digest: createHash('sha256').update(canonical).digest('hex') };
  return { config, policy, routePolicy, gateway, record, report };
}

function reader(outputs) {
  const calls = [];
  return { calls, readVolume: async (...args) => {
    calls.push(args);
    const output = outputs[calls.length - 1];
    if (output instanceof Error) throw output;
    return typeof output === 'string' ? output : JSON.stringify(output) + '\n';
  } };
}

async function refused(promise) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'DURABLE_STORES_REFUSED');
    assert.equal(error.message, 'Durable route stores could not be verified; keep ingress stopped');
    assert.doesNotMatch(error.message + String(error.stack), /private|sha256:|example\.com/);
    return true;
  });
}

test('reads both stores read-only with fixed code, image, volumes and nonsecret input', async () => {
  const f = fixture(), r = reader([f.gateway, f.report]);
  const result = await readDurableStores(f.config, f.policy, { readVolume: r.readVolume });
  assert.deepEqual(result, { authority: { record: f.record, sha256: f.report.digest }, gatewayPolicy: f.gateway });
  assert.equal(r.calls.length, 2);
  const [[gImage, gVolume, gArgs, gOptions], [aImage, aVolume, aArgs, aOptions]] = r.calls;
  assert.equal(gImage, f.policy.image); assert.equal(aImage, f.policy.image);
  assert.equal(gVolume, 'original_gateway-policy'); assert.equal(aVolume, 'original_route-authority');
  assert.deepEqual(gOptions, { readonly: true, entrypoint: '/usr/local/bin/node', capabilities: [] });
  assert.deepEqual(aOptions, { readonly: true, entrypoint: '/usr/local/bin/node', capabilities: [], inputText: JSON.stringify(f.routePolicy) });
  assert.deepEqual(gArgs.slice(0, 2), ['--input-type=module', '-e']);
  assert.match(gArgs[2], /\.\/packages\/runtime\/src\/gateway-launch-policy\.mjs'.*readGatewayLaunchPolicy\('\/data'\)/);
  assert.match(aArgs[2], /\.\/packages\/platform\/src\/route-record-store\.mjs'.*readRouteRecord\('\/data\/routes\.json'/);
  assert.doesNotMatch(JSON.stringify(r.calls), /private|AWS_|PASSWORD|TOKEN/);
});

test('profile and sealed config must be independently consistent', async () => {
  const f = fixture();
  for (const [config, profile] of [
    [{ ...f.config, volumes: { ...f.config.volumes, 'gateway-policy': { name: 'foreign' } } }, f.policy],
    [f.config, { ...f.policy, image: 'sha256:' + 'f'.repeat(64) }],
    [f.config, { ...f.policy, schema: 2 }],
    [f.config, null],
  ]) {
    const r = reader([f.gateway, f.report]);
    await refused(readDurableStores(config, profile, { readVolume: r.readVolume }));
    assert.equal(r.calls.length, 0);
  }
});

test('gateway plan must equal the independently derived plan', async () => {
  const f = fixture();
  const foreign = structuredClone(f.gateway); foreign.policy.installation = 'f'.repeat(64);
  const extra = { ...f.gateway, extra: true };
  const swapped = { ...f.gateway, slots: [...f.gateway.slots].reverse() };
  for (const output of [foreign, extra, swapped, null, 'not json\n', '', JSON.stringify(f.gateway).padEnd(16 * 1024 + 1), '{"schema":1,"x":"é"}\n', new Error('docker command failed: private-password')]) {
    const r = reader([output, f.report]);
    await refused(readDurableStores(f.config, f.policy, { readVolume: r.readVolume }));
    assert.equal(r.calls.length, 1);
  }
});

test('route authority must be present, strict and digest-bound', async () => {
  const f = fixture();
  const wrongInstallation = { ...f.report, record: { ...f.record, installation: 'f'.repeat(64) } };
  const loose = { ...f.report, record: { ...f.record, routes: [{ ...f.record.routes[0], extra: 1 }] } };
  const tampered = { ...f.report, digest: 'f'.repeat(64) };
  const big = JSON.stringify(f.report).padEnd(256 * 1024 + 1);
  for (const output of [null, {}, { ...f.report, extra: 1 }, { record: f.record }, wrongInstallation, loose, tampered, big, new Error('private')]) {
    const r = reader([f.gateway, output]);
    await refused(readDurableStores(f.config, f.policy, { readVolume: r.readVolume }));
    assert.equal(r.calls.length, 2);
  }
});
