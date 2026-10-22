import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';
import { freshRuntimePlan } from '../src/runtime/selection-plan.mjs';
import { selectedRecoveryPlan, requestedRecoveryRuntime, retiredRuntimePolicy } from '../src/runtime/recovery-selection.mjs';
import { restoredRuntimeConfig } from '../src/runtime/cron-preboot.mjs';
import { planRetirement } from '../src/recovery/retirement-plan.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

function fixture() {
  const entry = runtimeFamilies()[0], { source } = prebootFixture();
  for (const [name, service] of Object.entries(source.services)) service.image = name === 'minio' ? entry.storageImage : entry.image;
  const { config, policy } = freshRuntimePlan(source, entry, { control: '10.252.180.0/24', 'fleet-1': '10.252.181.0/24', 'fleet-2': '10.252.182.0/24' }, '00000000-0000-4000-8000-000000000001');
  const bundle = { config, manifest: { sourceProject: config.name, images: Object.fromEntries(Object.entries(config.services).map(([name, service]) => [name, service.image])) } };
  return { bundle, policy, selection: { runtime: entry.id, candidateEnrollment: true, expectedIdentity: runtimePolicyIdentity(policy) } };
}

test('recovery selection requires independent family and identity', () => {
  const { bundle, selection } = fixture();
  assert.equal(selectedRecoveryPlan(bundle), null);
  assert.throws(() => requestedRecoveryRuntime({ expectedIdentity: selection.expectedIdentity }), /explicit runtime/);
  assert.throws(() => requestedRecoveryRuntime({ networks: {} }), /explicit runtime/);
  assert.equal(requestedRecoveryRuntime(selection).id, selection.runtime);
  for (const identity of [undefined, '', 'a'.repeat(63), 'A'.repeat(64)]) {
    assert.throws(() => requestedRecoveryRuntime({ ...selection, expectedIdentity: identity }), /independently recorded/);
  }
  assert.throws(() => selectedRecoveryPlan(bundle, { ...selection, expectedIdentity: '0'.repeat(64) }), /independently expected/);
});

test('selected restore preserves logical identity but takes network placement independently', () => {
  const { bundle, policy, selection } = fixture(), before = structuredClone(bundle);
  const plan = selectedRecoveryPlan(bundle, selection);
  assert.deepEqual(plan.sourcePolicy, policy);
  assert.equal(runtimePolicyIdentity(plan.targetPolicy), selection.expectedIdentity);
  assert.equal(plan.targetPolicy.networks, undefined);
  assert.ok(Object.values(restoredRuntimeConfig(null, bundle.config, plan.targetPolicy).networks).every(n => n.ipam === undefined));
  const networks = { control: '10.253.180.0/24', 'fleet-1': '10.253.181.0/24', 'fleet-2': '10.253.182.0/24' };
  const placed = selectedRecoveryPlan(bundle, { ...selection, networks });
  assert.deepEqual(placed.targetPolicy.networks, networks);
  assert.equal(runtimePolicyIdentity(placed.targetPolicy), selection.expectedIdentity);
  assert.deepEqual(bundle, before);
});

test('every source program pin and sealed launch must match independent catalog selection', () => {
  const f = fixture();
  for (const name of Object.keys(f.bundle.manifest.images)) {
    const bundle = structuredClone(f.bundle); bundle.manifest.images[name] = 'sha256:' + '0'.repeat(64);
    assert.throws(() => selectedRecoveryPlan(bundle, f.selection), /Snapshot images differ/);
  }
  for (const alter of [
    c => { c.services.controller.image = 'fogd-runtime:local'; },
    c => { c.services.controller.build = '.'; },
    c => { c.services['slot-1-a'].environment.NODE_OPTIONS = '--import=/private'; },
    c => { c.services.workerd.volumes = [{ type: 'volume', source: 'controller', target: '/app' }]; },
  ]) {
    const bundle = structuredClone(f.bundle); alter(bundle.config);
    assert.throws(() => selectedRecoveryPlan(bundle, f.selection));
  }
});

test('source identity changes and snapshot-supplied policy cannot authorize selected recovery', () => {
  const f = fixture();
  for (const alter of [
    c => { c.services['slot-1-a'].environment.CELLD_NODE = 'foreign-node'; },
    c => { for (const service of Object.values(c.services)) if (service.environment.AWS_REGION) service.environment.AWS_REGION = 'other-region'; },
    c => { c.volumes['runtime-policy'].name = 'foreign-policy'; },
  ]) {
    const bundle = structuredClone(f.bundle); alter(bundle.config);
    bundle.manifest.runtimeProfile = f.policy; bundle.manifest.expectedIdentity = f.selection.expectedIdentity;
    assert.throws(() => selectedRecoveryPlan(bundle, f.selection));
  }
  delete f.bundle.config.volumes['runtime-policy']; f.bundle.config.services.controller.volumes.pop();
  assert.throws(() => selectedRecoveryPlan(f.bundle, f.selection), /selected-runtime source/);
});

test('retirement derives fresh policy only for its replacement fleet while preserving survivor identities', () => {
  const { bundle, policy, selection } = fixture(), digest = 'a'.repeat(64), plan = selectedRecoveryPlan(bundle, selection);
  const state = { apps: { notebook: { slot: 'slot-2', active: 'release', route: 'active' }, survivor: { slot: 'slot-1', active: 'other', route: 'active' } }, deployments: { release: { app: 'notebook', status: 'active', digest }, other: { app: 'survivor', status: 'active', digest } } };
  const retired = planRetirement(bundle.config, state, 'notebook', digest, { id: '00000000-0000-4000-8000-000000000002', at: '2026-10-21T00:00:00.000Z' }), target = retiredRuntimePolicy(plan, retired.config, 'slot-2');
  assert.notEqual(runtimePolicyIdentity(target), selection.expectedIdentity);
  assert.deepEqual(target.fleets[0], policy.fleets[0]);
  assert.notEqual(target.fleets[1].prefix, policy.fleets[1].prefix);
  assert.ok(target.fleets[1].nodes.every(node => !policy.fleets[1].nodes.some(old => old.id === node.id)));
  assert.deepEqual(retired.state.apps.survivor, state.apps.survivor);
  assert.equal(retired.state.apps.notebook.route, 'retired');
  assert.deepEqual(retired.skipped, ['slot-2-a', 'slot-2-b']);
  assert.deepEqual(restoredRuntimeConfig(retired.state, retired.config, target).services['slot-1-a'], bundle.config.services['slot-1-a']);
});


test('selected recovery refuses publishing storage/native listeners or divergent ingress profiles', () => {
  for (const alter of [
    c => { c.services.minio.ports = [{ host_ip: '127.0.0.1', mode: 'ingress', published: '19001', target: 9001, protocol: 'tcp' }]; },
    c => { c.services.controller.ports = [{ host_ip: '127.0.0.1', mode: 'ingress', published: '19001', target: 8081, protocol: 'tcp' }]; },
    c => { c.services.workerd.ports = ['127.0.0.1:19001:8080']; },
    c => { c.services.workerd.environment.FOGD_TLS = '1'; },
    c => { c.services.controller.environment.FOGD_PUBLIC_BIND_ADDRESS = '0.0.0.0'; },
  ]) {
    const f = fixture(); alter(f.bundle.config); assert.throws(() => selectedRecoveryPlan(f.bundle, f.selection));
  }
});

test('retirement refuses a planner projection that changes survivor or storage identity', () => {
  const { bundle, selection } = fixture(), plan = selectedRecoveryPlan(bundle, selection);
  const config = structuredClone(bundle.config), slots = JSON.parse(config.services.controller.environment.FOGD_SLOTS);
  slots[1].prefix = 'retirement-generations/fresh';
  for (const name of ['controller', 'workerd']) config.services[name].environment.FOGD_SLOTS = JSON.stringify(slots);
  for (const host of slots[1].nodes) { config.services[host].environment.CELLD_NODE = host + '-replacement'; config.services[host].environment.CELLD_BUCKET = 's3://fogd/' + slots[1].prefix; }
  for (const alter of [
    c => { c.services['slot-1-a'].environment.CELLD_NODE = 'changed-survivor'; },
    c => { for (const service of Object.values(c.services)) if (service.environment.AWS_REGION) service.environment.AWS_REGION = 'other-region'; },
  ]) {
    const changed = structuredClone(config); alter(changed);
    assert.throws(() => retiredRuntimePolicy(plan, changed, 'slot-2'), /survivor or storage/);
  }
  assert.throws(() => retiredRuntimePolicy(plan, bundle.config, 'slot-2'), /fresh namespace/);
});

test('renderer-shaped TLS and local ingress are accepted and conflicting host ports refuse', () => {
  for (const tls of [false, true]) {
    const { bundle, selection } = fixture();
    for (const [name, target, published] of [['controller', 8082, '18788'], ['workerd', 8080, '18787']]) {
      const service = bundle.config.services[name];
      Object.assign(service.environment, { FOGD_PUBLIC_BIND_ADDRESS: '127.0.0.1', FOGD_PROFILE: tls ? 'shared' : 'local', FOGD_TLS: tls ? '1' : '0' });
      service.ports = [{ mode: 'ingress', host_ip: '127.0.0.1', target, published, protocol: 'tcp' }];
    }
    assert.ok(selectedRecoveryPlan(bundle, selection));
    bundle.config.services.workerd.ports[0].published = '18788';
    assert.throws(() => selectedRecoveryPlan(bundle, selection), /listeners overlap/);
  }
});
