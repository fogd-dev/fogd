import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { backupDurableInstallation } from '../src/recovery/durable-backup.mjs';
import { verifyBundle } from '../src/recovery/bundle.mjs';
import { verifyDurableBundle } from '../src/recovery/durable-bundle.mjs';
import { execute } from '../src/recovery/execute.mjs';
import { withStoppedDurableInstallation } from '../src/runtime/durable-stop.mjs';
import { acquireLaunchFence } from '../src/runtime/launch-fence.mjs';
import { beginDurableEnrollment } from '../src/runtime/enrollment-record.mjs';
import { durablePlanSha256 } from '../src/runtime/durable-config.mjs';
import { durableGatewayPlan } from '../src/runtime/durable-policies.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { initializeFreshRouteStores } from '../../platform/src/fresh-route-enrollment.mjs';
import { readRouteRecord } from '../../platform/src/route-record-store.mjs';
import { readRuntimePolicy, writeRuntimePolicy } from '../../platform/src/runtime-policy-file.mjs';
import { readGatewayLaunchPolicy, writeGatewayLaunchPolicy } from '../../runtime/src/gateway-launch-policy.mjs';
import { durableStopFixture } from './fixtures/durable-stop.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const f = await durableStopFixture(t), { config, policy } = f, paths = {};
  const volumes = join(f.root, 'volumes'); await mkdir(volumes);
  for (const [role, volume] of Object.entries(config.volumes)) { paths[role] = join(volumes, volume.name); await mkdir(paths[role]); }
  await writeRuntimePolicy(paths['runtime-policy'], policy, { createOnly: true });
  await writeGatewayLaunchPolicy(paths['gateway-policy'], durableGatewayPlan(policy));
  await initializeFreshRouteStores({ profile: policy, binding: hash('initial inventory') }, {
    controller: paths.controller, authority: paths['route-authority'], enrollment: paths['route-enrollment'] });
  const enrollment = await beginDurableEnrollment(f.directory, { project: config.name, installation: runtimePolicyIdentity(policy), planSha256: durablePlanSha256(config, policy) });
  await enrollment.complete(hash('initial inventory'));
  const calls = [], routePolicy = { installation: runtimePolicyIdentity(policy), slots: policy.fleets.map(fleet => fleet.id) };
  const options = { directory: f.directory, authorize: async () => f.options.families()[0], ready: async () => {}, verify: async () => {}, recovery: async () => {},
    policy: () => readRuntimePolicy(paths['runtime-policy'], config.services.controller.environment),
    state: async () => JSON.parse(await readFile(join(paths.controller, 'state.json'), 'utf8')),
    inspect: async () => ({ identity: hash('actual daemon fixture') }),
    stores: async () => { const observed = await readRouteRecord(join(paths['route-authority'], 'routes.json'), routePolicy); return {
      authority: { record: observed.record, sha256: observed.digest }, gatewayPolicy: await readGatewayLaunchPolicy(paths['gateway-policy']) }; },
    scope: (input, task) => withStoppedDurableInstallation(input, task, f.options),
    run: async (args, io) => {
      calls.push(args);
      await assert.rejects(acquireLaunchFence(f.directory, { project: config.name, installation: 'competing' }), { code: 'FENCE_EXISTS' });
      if (args[0] === 'image' && args[1] === 'save') return writeFile(io.output, 'mock image export bytes');
      assert.equal(args[0], 'run');
      const mount = args[args.indexOf('--mount') + 1], volume = mount.match(/src=([^,]+)/)[1];
      const role = Object.keys(paths).find(role => config.volumes[role].name === volume);
      await execute('tar', ['-cf', '-', '-C', paths[role], '.'], { output: io.output });
    } };
  return { ...f, paths, options, archiveCalls: calls, selected: { config, policy, entry: f.options.families()[0] }, destination: join(f.root, 'snapshot') };
}
const refused = work => assert.rejects(work, error => error.code === 'DURABLE_BACKUP_UNCONFIRMED' && !error.cause && !/private|sha256|original_/.test(error.message));

test('durable backup holds the actual shutdown fence while producing and verifying real paired archives', async t => {
  const f = await fixture(t), before = await readFile(join(f.paths.controller, 'state.json'));
  const manifest = await backupDurableInstallation(f.destination, f.selected, {}, f.options);
  assert.equal(manifest.format, 'fogd-stopped-durable-v1');
  const checked = await verifyDurableBundle(f.destination, f.policy); assert.deepEqual(checked.manifest, manifest);
  const names = (await readdir(f.destination)).sort();
  for (const role of ['runtime-policy', 'gateway-policy', 'route-enrollment']) assert.equal(names.includes(`${role}.tar`), false);
  assert.ok(names.includes('route-authority.tar')); assert.ok(names.includes('controller.tar'));
  assert.ok(f.archiveCalls.filter(args => args[0] === 'run').every(args => args[args.indexOf('--pull') + 1] === 'never' && args[args.indexOf('--mount') + 1].endsWith(',volume-nocopy,readonly')));
  assert.deepEqual(await readFile(join(f.paths.controller, 'state.json')), before);
  assert.deepEqual((await readdir(f.directory)).sort(), ['enrollment.complete.json', 'enrollment.pending.json']);
  assert.ok(f.engine.containers.every(container => !container.State.Running));
  await assert.rejects(verifyBundle(f.destination), /unsupported backup manifest/);
});
test('an existing output refuses before background preparation or shutdown', async t => {
  const f = await fixture(t); await mkdir(f.destination); await writeFile(join(f.destination, 'keep'), 'retained');
  f.options.prepare = async () => assert.fail('No pause'); f.options.scope = async () => assert.fail('No shutdown');
  await refused(backupDurableInstallation(f.destination, f.selected, {}, f.options));
  assert.equal(await readFile(join(f.destination, 'keep'), 'utf8'), 'retained');
});
test('missing host enrollment cannot authorize a snapshot or background pause', async t => {
  const f = await fixture(t);
  await rm(join(f.directory, 'enrollment.pending.json')); await rm(join(f.directory, 'enrollment.complete.json'));
  f.options.prepare = async () => assert.fail('No pause');
  await refused(backupDurableInstallation(f.destination, f.selected, {}, f.options));
  await assert.rejects(access(f.destination), { code: 'ENOENT' });
});
test('a partial archive failure retains stopped source, enrollment and incomplete output behind the fence', async t => {
  const f = await fixture(t), run = f.options.run;
  f.options.run = async (args, io) => { if (io.output.endsWith('route-authority.tar')) throw new Error('injected archive failure'); return run(args, io); };
  await refused(backupDurableInstallation(f.destination, f.selected, {}, f.options));
  assert.equal(JSON.parse(await readFile(join(f.directory, 'launch.pending.json'))).phase, 'stopping');
  assert.ok((await readdir(f.destination)).includes('controller.tar'));
  await assert.rejects(access(join(f.destination, 'manifest.json')), { code: 'ENOENT' });
  assert.ok(f.engine.containers.every(container => !container.State.Running));
});
test('changed resource identity after shutdown cannot begin archives', async t => {
  const f = await fixture(t); let reads = 0;
  f.options.inspect = async () => ({ identity: hash(++reads === 1 ? 'first' : 'replaced') });
  await refused(backupDurableInstallation(f.destination, f.selected, {}, f.options));
  assert.deepEqual(f.archiveCalls, []); assert.deepEqual(await readdir(f.destination), []);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'launch.pending.json'))).phase, 'stopping');
});
test('a changed public file in the actual archive cannot pass the final pair verifier', async t => {
  const f = await fixture(t), run = f.options.run;
  f.options.run = async (args, io) => {
    if (io.output.endsWith('route-authority.tar')) {
      const file = join(f.paths['route-authority'], 'routes.json'), record = JSON.parse(await readFile(file));
      record.revision = '1'; await writeFile(file, JSON.stringify(record, null, 2));
    }
    return run(args, io);
  };
  await refused(backupDurableInstallation(f.destination, f.selected, {}, f.options));
  await assert.rejects(verifyDurableBundle(f.destination, f.policy), { code: 'DURABLE_BUNDLE_REFUSED' });
  assert.equal(JSON.parse(await readFile(join(f.directory, 'launch.pending.json'))).phase, 'stopping');
});
