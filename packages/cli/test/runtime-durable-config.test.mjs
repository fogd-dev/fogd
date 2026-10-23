import test from 'node:test';
import assert from 'node:assert/strict';
import { durableRuntimeConfig } from '../src/runtime/durable-config.mjs';
import { freshRuntimePlan, runtimePolicyForConfig, selectedRuntimeConfig } from '../src/runtime/selection-plan.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

const routes = { type: 'volume', source: 'route-authority', target: '/var/lib/fogd-routes', volume: { nocopy: true } };
function fixture() {
  const { source, profile } = prebootFixture();
  source.services.controller.environment.FOGD_GATEWAY_TOKEN = 'private-gateway';
  const legacyEntry = { ...profile, id: 'celld-cron-v2-linux-arm64', admission: 'candidate' };
  const entry = { ...legacyEntry, routing: 'durable' };
  const legacy = freshRuntimePlan(source, legacyEntry), policy = runtimePolicyForConfig(legacy.config, entry);
  return { source, entry, legacyEntry, legacy, policy, durable: durableRuntimeConfig(legacy.config, policy) };
}

test('conversion seals the candidate topology and preserves its input', () => {
  const f = fixture(), before = structuredClone(f.legacy.config), { durable: c } = f;
  assert.deepEqual(f.legacy.config, before);
  assert.equal(f.policy.schema, 3); assert.equal(f.policy.routing, 'durable');
  assert.deepEqual(f.policy.controllerArgs, ['packages/platform/src/main-durable.mjs']);
  assert.deepEqual(c.volumes['route-authority'], { name: 'original_route-authority' });
  assert.deepEqual(c.volumes['gateway-policy'], { name: 'original_gateway-policy' });
  assert.deepEqual(c.services.controller.command, ['packages/platform/src/main-durable.mjs']);
  assert.deepEqual(c.services.controller.volumes.at(-1), routes);
  assert.ok(c.services.controller.volumes.some(m => m.source === 'runtime-policy' && m.read_only));
  const gateway = c.services.workerd;
  assert.deepEqual(gateway.command, ['packages/runtime/src/serve-durable.mjs']);
  assert.deepEqual(gateway.entrypoint, ['/usr/local/bin/node']);
  assert.equal(gateway.restart, 'no');
  assert.deepEqual(gateway.environment, {});
  assert.deepEqual(Object.keys(gateway.networks).sort(), ['fleet-1', 'fleet-2']);
  assert.deepEqual(gateway.volumes, [{ ...routes, read_only: true },
    { type: 'volume', source: 'gateway-policy', target: '/var/lib/fogd-gateway', read_only: true, volume: { nocopy: true } }]);
  for (const service of Object.values(c.services)) {
    assert.equal(service.read_only, true); assert.equal(service.pull_policy, 'never'); assert.deepEqual(service.cap_drop, ['ALL']);
  }
  for (const name of ['slot-1-a', 'minio', 'bucket-init']) assert.ok(!(c.services[name].volumes || []).some(m => ['route-authority', 'gateway-policy'].includes(m.source)));
});

test('sealed durable config re-enters idempotently through both entrypoints', () => {
  const f = fixture(), before = structuredClone(f.durable);
  assert.deepEqual(durableRuntimeConfig(f.durable, f.policy), f.durable);
  assert.deepEqual(selectedRuntimeConfig(f.durable, f.entry, f.policy), f.durable);
  assert.deepEqual(runtimePolicyForConfig(f.durable, f.entry), f.policy);
  assert.deepEqual(f.durable, before);
  const plan = freshRuntimePlan(f.source, f.entry);
  assert.equal(plan.policy.schema, 3);
  assert.deepEqual(selectedRuntimeConfig(plan.config, f.entry, plan.policy), plan.config);
  assert.deepEqual(plan.config.services.workerd.command, ['packages/runtime/src/serve-durable.mjs']);
});

test('gateway keeps only transport fields', () => {
  const { source, profile } = prebootFixture();
  Object.assign(source.services.workerd.environment, { FOGD_TLS: '1', FOGD_PUBLIC_BIND_ADDRESS: '127.0.0.1' });
  Object.assign(source.services.controller.environment, { FOGD_TLS: '1', FOGD_PUBLIC_BIND_ADDRESS: '127.0.0.1' });
  const plan = freshRuntimePlan(source, { ...profile, id: 'celld-cron-v2-linux-arm64', admission: 'candidate', routing: 'durable' });
  assert.deepEqual(plan.config.services.workerd.environment, { FOGD_TLS: '1', FOGD_PUBLIC_BIND_ADDRESS: '127.0.0.1' });
});

test('durable re-entry refuses drift instead of repairing it, without exposing private values', () => {
  for (const alter of [
    c => { c.services.workerd.volumes[0].source = 'controller'; },
    c => { c.services.workerd.volumes[1].target = '/var/lib/fogd-routes'; },
    c => { c.services['slot-1-a'].volumes.push({ ...routes }); },
    c => { c.services.minio.volumes.push({ ...routes, target: '/data/routes' }); },
    c => { delete c.services.workerd.volumes[0].read_only; },
    c => { c.services.workerd.volumes[1].read_only = false; },
    c => { c.services.controller.volumes.at(-1).read_only = true; },
    c => { delete c.services.controller.volumes.at(-1).volume; },
    c => { c.services.controller.volumes.pop(); },
    c => { c.services.workerd.volumes.push({ type: 'volume', source: 'runtime-policy', target: '/var/lib/fogd-runtime', read_only: true, volume: { nocopy: true } }); },
    c => { c.services.controller.command = ['packages/platform/src/main.mjs']; },
    c => { c.services.controller.command = ['node', 'packages/platform/src/main-durable.mjs']; },
    c => { c.services.workerd.command = ['packages/runtime/src/serve.mjs']; },
    c => { c.services.workerd.entrypoint = ['sh', '-c']; },
    c => { c.services.workerd.environment.FOGD_CONTROLLER = 'controller:8083'; },
    c => { c.services.workerd.environment.FOGD_GATEWAY_TOKEN = 'private-gateway'; },
    c => { c.services.workerd.environment.FOGD_SLOTS = c.services.controller.environment.FOGD_SLOTS; },
    c => { c.services.workerd.environment.AWS_SECRET_ACCESS_KEY = 'private-password'; },
    c => { c.services.workerd.environment.FOGD_ADMIN_PASSWORD = 'private-admin'; },
    c => { c.services.workerd.networks.control = null; },
    c => { c.services.workerd.image = 'fogd-runtime:local'; },
    c => { c.services.controller.image = 'mutable:tag'; },
    c => { c.services.workerd.read_only = false; },
    c => { c.services.workerd.restart = 'unless-stopped'; },
    c => { c.volumes['route-authority'].name = 'private-other_route-authority'; },
    c => { c.volumes['gateway-policy'].name = c.volumes['route-authority'].name; },
    c => { c.volumes['route-authority'].name = c.volumes.controller.name; },
    c => { c.volumes['gateway-policy'].driver_opts = { device: '/private' }; },
    c => { delete c.volumes['gateway-policy']; c.services.workerd.volumes.pop(); },
    c => { delete c.volumes['runtime-policy']; },
    c => { c.services['slot-1-a'].environment.CELLD_NODE = 'private-other'; },
  ]) {
    const f = fixture(), c = structuredClone(f.durable); alter(c); const before = structuredClone(c);
    for (const run of [() => durableRuntimeConfig(c, f.policy), () => selectedRuntimeConfig(c, f.entry, f.policy)]) {
      assert.throws(run, error => !/private/.test(error.message), alter.toString());
    }
    assert.deepEqual(c, before);
  }
});

test('conversion refuses colliding role names and an unpinned legacy base', () => {
  for (const alter of [
    c => { c.volumes.controller.name = 'original_route-authority'; },
    c => { c.volumes.bucket.name = 'original_gateway-policy'; },
    c => { c.services.workerd.image = 'mutable:tag'; },
  ]) {
    const f = fixture(), c = structuredClone(f.legacy.config); alter(c);
    assert.throws(() => durableRuntimeConfig(c, f.policy));
  }
});

test('foreign or legacy policies and mismatched families cannot authorize durable routing', () => {
  const f = fixture();
  assert.throws(() => durableRuntimeConfig(f.legacy.config, f.legacy.policy), { code: 'DURABLE_CONFIG_REFUSED' });
  assert.throws(() => durableRuntimeConfig(f.durable, f.legacy.policy), { code: 'DURABLE_CONFIG_REFUSED' });
  for (const change of [p => { p.bucket = 'other'; }, p => { p.image = 'sha256:' + 'e'.repeat(64); }, p => { p.fleets[0].nodes[0].id = 'other'; },
    p => { p.controllerArgs = ['packages/platform/src/main.mjs']; }, p => { delete p.routing; }]) {
    const policy = structuredClone(f.policy); change(policy);
    assert.throws(() => durableRuntimeConfig(f.durable, policy), { code: 'DURABLE_CONFIG_REFUSED' });
  }
  assert.throws(() => selectedRuntimeConfig(f.durable, f.legacyEntry, f.policy), /routing differs/);
  assert.throws(() => selectedRuntimeConfig(f.legacy.config, f.entry, f.legacy.policy), /routing differs/);
  assert.throws(() => selectedRuntimeConfig(f.durable, { ...f.entry, id: 'foreign-family' }, f.policy), /family differs/);
  assert.throws(() => runtimePolicyForConfig(f.durable, f.legacyEntry), /durable-capable/);
  assert.throws(() => runtimePolicyForConfig(f.legacy.config, { ...f.entry, routing: 'legacy' }), /routing/);
  assert.throws(() => runtimePolicyForConfig(f.legacy.config, { ...f.entry, schema: 1 }), /routing/);
  assert.equal(runtimePolicyForConfig(f.legacy.config, f.legacyEntry).schema, 2);
});
