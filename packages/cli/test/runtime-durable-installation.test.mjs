import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { enrollDurableInstallation } from '../src/runtime/durable-installation.mjs';
import { freshRuntimePlan } from '../src/runtime/selection-plan.mjs';
import { durablePlanSha256 } from '../src/runtime/durable-config.mjs';
import { installDurablePolicies } from '../src/runtime/durable-policies.mjs';
import { initializeDurableRoutes } from '../src/runtime/durable-enrollment.mjs';
import { readDurableStores } from '../src/runtime/durable-stores.mjs';
import { assertDurableEnrollmentReady } from '../src/runtime/enrollment-record.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';
import { readRuntimePolicy, writeRuntimePolicy } from '../../platform/src/runtime-policy-file.mjs';
import { readGatewayLaunchPolicy, writeGatewayLaunchPolicy } from '../../runtime/src/gateway-launch-policy.mjs';
import { initializeFreshRouteStores } from '../../platform/src/fresh-route-enrollment.mjs';
import { readRouteRecord } from '../../platform/src/route-record-store.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { Controller } from '../../platform/src/controller.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-fresh-installation-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'host'), volumes = join(root, 'volumes'); await mkdir(directory, { mode: 0o700 }); await mkdir(volumes);
  const { source, profile } = prebootFixture(), entry = { ...profile, schema: 2, id: 'durable-candidate', admission: 'candidate', routing: 'durable' };
  const plan = freshRuntimePlan(source, entry), selected = { ...plan, entry }, events = []; let created = false;
  const volumePath = name => join(volumes, name), rolePath = role => volumePath(plan.config.volumes[role].name);
  // Translate only the fixed helper entrypoints into their actual filesystem
  // functions. Docker transport, image execution and mount semantics are not tested.
  const readVolume = async (_image, name, args, options = {}) => {
    const path = volumePath(name), input = options.inputText && JSON.parse(options.inputText), code = args.at(-1);
    if (args[0] === 'packages/platform/src/import-fresh-runtime-policy.mjs') return JSON.stringify(await writeRuntimePolicy(path, input, { createOnly: true }));
    if (code.includes('writeGatewayLaunchPolicy')) return JSON.stringify(await writeGatewayLaunchPolicy(path, input));
    if (code.includes('readGatewayLaunchPolicy')) return JSON.stringify(await readGatewayLaunchPolicy(path));
    if (code.includes('readRouteRecord')) return JSON.stringify(await readRouteRecord(join(path, 'routes.json'), input));
    throw new Error('Unexpected helper');
  };
  const run = async (args, options = {}) => {
    events.push(args);
    const pending = JSON.parse(await readFile(join(directory, 'enrollment.pending.json'), 'utf8')); assert.equal(pending.project, plan.config.name);
    if (args[0] === 'volume') { await mkdir(volumePath(args.at(-1)), { mode: 0o755 }); return args.at(-1); }
    if (args[0] === 'compose') {
      for (const volume of Object.values(plan.config.volumes)) await mkdir(volumePath(volume.name), { recursive: true, mode: 0o755 });
      created = true; return '';
    }
    if (args[0] === 'run') return JSON.stringify(await initializeFreshRouteStores(JSON.parse(options.inputText), {
      controller: rolePath('controller'), authority: rolePath('route-authority'), enrollment: rolePath('route-enrollment') }));
    throw new Error('Unexpected Docker mutation');
  };
  const snapshot = () => ({ identity: hash('inventory'), services: Object.fromEntries(Object.keys(plan.config.services).map(name => [name,
    { id: hash(name), running: false, restarting: false, paused: false, status: 'created', exitCode: 0, startedAt: '0001-01-01T00:00:00Z' }])) });
  const options = { run, authorize: async () => entry, ready: async () => {}, recovery: async () => {}, verify: async () => {}, networks: async () => {},
    fresh: async () => { if (created) throw new Error('Resources already exist'); },
    reserve: async (config, opts) => { assert.equal(opts.reserve, true); const file = join(directory, 'compose.json'); await writeFile(file, JSON.stringify(config), { flag: 'wx', mode: 0o600 }); return file; },
    inspect: async () => snapshot(),
    policies: (config, policy) => installDurablePolicies(config, policy, { readVolume, readPolicy: (_image, name, env) => readRuntimePolicy(volumePath(name), env) }),
    routes: (config, policy, binding) => initializeDurableRoutes(config, policy, binding, { run }),
    stores: (config, policy) => readDurableStores(config, policy, { readVolume }) };
  return { root, directory, selected, options, events, snapshot, rolePath };
}
test('fresh enrollment connects actual policy writers, grant spending and route publication before declaring completion', async t => {
  const f = await fixture(t), result = await enrollDurableInstallation(f.selected, f.options);
  const record = await assertDurableEnrollmentReady(f.directory, { project: result.config.name, installation: runtimePolicyIdentity(result.policy), planSha256: durablePlanSha256(result.config, result.policy) });
  assert.equal(record.inventoryBinding, hash('inventory'));
  assert.deepEqual(f.events.map(args => args[0]), ['volume', 'compose', 'run']);
  assert.ok(f.events[1].includes('--no-build')); assert.ok(f.events[1].includes('create')); assert.equal(f.events.some(args => args.includes('up') || args[0] === 'start'), false);
  const spent = JSON.parse(await readFile(join(f.rolePath('route-enrollment'), 'route-enrollment.spent.json'), 'utf8'));
  const state = JSON.parse(await readFile(join(f.rolePath('controller'), 'state.json'), 'utf8'));
  assert.match(spent.id, /^[a-f0-9-]{36}$/); assert.equal(state.routeAuthority.pending, null); assert.equal(state.routeAuthority.settled.revision, '0');
  const controller = new Controller({ dir: f.rolePath('controller'), backend: { owner: async () => null },
    slots: result.policy.fleets.map(fleet => ({ id: fleet.id, prefix: fleet.prefix, nodes: fleet.nodes.map(node => node.host) })),
    routeAuthority: { path: join(f.rolePath('route-authority'), 'routes.json'), policy: { installation: runtimePolicyIdentity(result.policy), slots: ['slot-1', 'slot-2'] }, verifyRuntime: async () => assert.fail('No active applications') } });
  await controller.init(); assert.equal(controller.routingStartupComplete, true);
  await assert.rejects(enrollDurableInstallation(f.selected, f.options), { code: 'DURABLE_INSTALLATION_UNCONFIRMED' });
  assert.deepEqual((await readdir(f.directory)).sort(), ['compose.json', 'enrollment.complete.json', 'enrollment.pending.json']);
});
test('failed policy installation retains resources and a permanent incomplete enrollment fence', async t => {
  const f = await fixture(t); f.options.policies = async () => { throw new Error('PRIVATE failure'); };
  await assert.rejects(enrollDurableInstallation(f.selected, f.options), error => error.code === 'DURABLE_INSTALLATION_UNCONFIRMED' && !error.message.includes('PRIVATE') && !('cause' in error));
  await assert.rejects(assertDurableEnrollmentReady(f.directory), { code: 'ENROLLMENT_NOT_READY' });
  assert.deepEqual((await readdir(f.directory)).sort(), ['compose.json', 'enrollment.pending.json']);
  assert.ok((await readdir(dirname(f.rolePath('controller')))).length > 0);
});
test('a foreign inventory after policy writes cannot issue a route grant', async t => {
  const f = await fixture(t); let calls = 0, issued = false;
  f.options.inspect = async () => ({ ...f.snapshot(), identity: hash(++calls === 1 ? 'inventory' : 'foreign') });
  f.options.routes = async () => { issued = true; throw new Error('Unexpected initializer'); };
  await assert.rejects(enrollDurableInstallation(f.selected, f.options), { code: 'DURABLE_INSTALLATION_UNCONFIRMED' });
  assert.equal(issued, false); await assert.rejects(assertDurableEnrollmentReady(f.directory), { code: 'ENROLLMENT_NOT_READY' });
});
test('initially live containers cannot install any policies or issue a grant', async t => {
  const f = await fixture(t); let policies = false;
  f.options.inspect = async () => { const result = f.snapshot(); result.services.controller.running = true; result.services.controller.status = 'running'; return result; };
  f.options.policies = async () => { policies = true; };
  await assert.rejects(enrollDurableInstallation(f.selected, f.options), { code: 'DURABLE_INSTALLATION_UNCONFIRMED' });
  assert.equal(policies, false); await assert.rejects(assertDurableEnrollmentReady(f.directory), { code: 'ENROLLMENT_NOT_READY' });
});
