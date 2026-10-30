import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { planDurableRestore, readDurableRestorePlan } from '../src/runtime/durable-recovery-plan.mjs';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';
import { durableRuntimeConfig } from '../src/runtime/durable-config.mjs';
import { verifyDurableBundle } from '../src/recovery/durable-bundle.mjs';
import { fingerprint } from '../src/recovery/bundle.mjs';
import { archiveDataFixture } from './fixtures/app-archive-data.mjs';
import { prepareSnapshotRouteRestoration } from '@fogd/platform/route-restoration';
import { durableBundleFixture } from './fixtures/durable-bundle.mjs';

async function fixture(t) {
  const f = await durableBundleFixture(t), p = f.policy;
  const entry = { ...runtimeFamilies()[0], schema: 2, id: p.family, admission: p.admission, routing: 'durable',
    image: p.image, storageImage: p.storageImage, binarySha256: p.binarySha256, supervisorSha256: p.supervisorSha256 };
  await writeFile(join(f.dir, 'manifest.json'), JSON.stringify(f.manifest));
  const checked = await verifyDurableBundle(f.dir, p), snapshot = (await fingerprint(join(f.dir, 'manifest.json'))).sha256;
  const selection = { entry, project: 'recovered', expectedIdentity: runtimePolicyIdentity(p), snapshot };
  return { ...f, checked, selection, choice: { choose: () => entry } };
}
const refused = work => assert.rejects(work, error => error.code === 'DURABLE_RECOVERY_PLAN_REFUSED' && !error.cause && !/private|sha256|original_/.test(error.message));

test('restore planning preserves native and application identities while allocating canonical target roles', async t => {
  const f = await fixture(t), before = structuredClone(f.checked), plan = planDurableRestore(f.checked, f.selection);
  assert.deepEqual(f.checked, before); assert.equal(plan.target.config.name, 'recovered');
  assert.deepEqual(plan.target.policy.fleets, f.policy.fleets); assert.equal(runtimePolicyIdentity(plan.target.policy), f.selection.expectedIdentity);
  assert.deepEqual(plan.source.state.deployments, f.state.deployments); assert.equal(plan.snapshot, f.selection.snapshot);
  assert.deepEqual(plan.target.config, durableRuntimeConfig(plan.target.config, plan.target.policy));
  for (const [role, volume] of Object.entries(plan.target.config.volumes)) assert.equal(volume.name, `recovered_${role}`);
  for (const role of ['route-authority', 'gateway-policy', 'route-enrollment']) assert.ok(plan.target.config.volumes[role]);
  plan.source.state.apps.alpha.route = 'paused'; assert.equal(f.checked.state.apps.alpha.route, 'active');
});
test('only independent target network selection can place a restored installation', async t => {
  const f = await fixture(t), networks = { control: '10.92.0.0/24', 'fleet-1': '10.92.1.0/24', 'fleet-2': '10.92.2.0/24' };
  const plan = planDurableRestore(f.checked, { ...f.selection, networks });
  assert.deepEqual(plan.target.policy.networks, networks); assert.equal(runtimePolicyIdentity(plan.target.policy), f.selection.expectedIdentity);
  for (const [name, network] of Object.entries(plan.target.config.networks)) assert.deepEqual(network.ipam.config, [{ subnet: networks[name] }]);
  assert.equal(plan.source.policy.networks, undefined);
});
test('wrong family, source identity, target name or snapshot reference cannot produce a plan', async t => {
  const f = await fixture(t);
  const cases = [{ expectedIdentity: 'f'.repeat(64) }, { project: 'original' }, { project: '../other' }, { snapshot: 'not a digest' },
    { entry: { ...f.selection.entry, image: 'sha256:' + 'e'.repeat(64) } },
    { entry: { ...f.selection.entry, routing: undefined, schema: 1 } },
    { networks: { control: '0.0.0.0/0' } }];
  for (const change of cases) assert.throws(() => planDurableRestore(f.checked, { ...f.selection, ...change }), { code: 'DURABLE_RECOVERY_PLAN_REFUSED' });
});
test('source image, route and ingress mismatches cannot be hidden by an expected storage identity', async t => {
  const f = await fixture(t);
  const changes = [b => { b.manifest.images.controller = 'sha256:' + 'e'.repeat(64); }, b => { b.authority.record.routes[0].digest = 'f'.repeat(64); },
    b => { b.config.services.controller.ports = [{ host_ip: '0.0.0.0', target: 8082, published: '8082', mode: 'ingress', protocol: 'tcp' }]; },
    b => { b.manifest.routeAuthority.revision = '999'; }];
  for (const change of changes) { const bundle = structuredClone(f.checked); change(bundle); assert.throws(() => planDurableRestore(bundle, f.selection), { code: 'DURABLE_RECOVERY_PLAN_REFUSED' }); }
});
test('filesystem selection verifies actual bundle bytes and derives its snapshot digest without writing output', async t => {
  const f = await fixture(t), before = await readdir(f.dir), manifest = await readFile(join(f.dir, 'manifest.json'));
  const plan = await readDurableRestorePlan(f.dir, 'recovered', { expectedIdentity: f.selection.expectedIdentity }, f.choice);
  assert.equal(plan.snapshot, f.selection.snapshot); assert.deepEqual(await readdir(f.dir), before);
  assert.deepEqual(await readFile(join(f.dir, 'manifest.json')), manifest);
  await writeFile(join(f.dir, 'controller.tar'), 'changed actual data');
  await refused(readDurableRestorePlan(f.dir, 'recovered', { expectedIdentity: f.selection.expectedIdentity }, f.choice));
});
test('ordinary selection remains closed without an eligible durable catalog entry or external identity', async t => {
  const f = await fixture(t);
  await refused(readDurableRestorePlan(f.dir, 'recovered', {}));
  await refused(readDurableRestorePlan(f.dir, 'recovered', { expectedIdentity: f.selection.expectedIdentity }));
  await refused(readDurableRestorePlan(f.dir, 'recovered', { runtime: 'unknown', expectedIdentity: f.selection.expectedIdentity }));
  await refused(readDurableRestorePlan(f.dir, 'recovered', {}, f.choice));
});

test('whole archive-mode recovery plans preserve detached history and the surviving app from verified bytes', async t => {
  const entry = { ...runtimeFamilies()[0], schema: 3, routing: 'durable', id: 'archive-whole-candidate', admission: 'candidate' };
  entry.sourceFiles = { ...entry.sourceFiles, 'packages/platform/src/main-archive.mjs': 'a'.repeat(64) };
  const f = await archiveDataFixture(t, entry), source = f.selection.currentProfile;
  const plan = await readDurableRestorePlan(f.currentDir, 'fogd-archive-whole-recovered', { expectedIdentity: runtimePolicyIdentity(source) }, { choose: () => entry });
  assert.equal(plan.target.policy.schema, 4);
  assert.equal(runtimePolicyIdentity(plan.target.policy), runtimePolicyIdentity(source));
  assert.deepEqual(plan.source.state.appArchives, f.currentState.appArchives);
  assert.equal(plan.source.state.apps.beta.route, 'active');
  const projected = prepareSnapshotRouteRestoration({ profile: plan.target.policy, sourceProfile: plan.source.policy,
    source: { state: plan.source.state, authority: plan.source.authority }, snapshot: plan.snapshot, binding: 'b'.repeat(64), domain: plan.domain });
  assert.equal(projected.state.apps.alpha.route, 'archived');
  assert.equal(projected.state.apps.beta.route, 'paused');
  assert.deepEqual(projected.state.appArchives, plan.source.state.appArchives);
  await assert.rejects(readDurableRestorePlan(f.currentDir, 'fogd-archive-whole-recovered', { expectedIdentity: runtimePolicyIdentity(source) },
    { choose: () => ({ ...entry, schema: 2 }) }), { code: 'DURABLE_RECOVERY_PLAN_REFUSED' });
});
