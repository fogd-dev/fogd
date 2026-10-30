import { restoreAppArchiveStores, restoreAppArchiveRecoveryStores } from '@fogd/platform/app-archive-routes';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { freshRuntimePlan } from '../../src/runtime/selection-plan.mjs';
import { installDurablePolicies } from '../../src/runtime/durable-policies.mjs';
import { initializeDurableRoutes } from '../../src/runtime/durable-enrollment.mjs';
import { readDurableStores } from '../../src/runtime/durable-stores.mjs';
import { prebootFixture } from './cron-preboot.mjs';
import { readRuntimePolicy, writeRuntimePolicy } from '../../../platform/src/runtime-policy-file.mjs';
import { readGatewayLaunchPolicy, writeGatewayLaunchPolicy } from '../../../runtime/src/gateway-launch-policy.mjs';
import { initializeFreshRouteStores } from '../../../platform/src/fresh-route-enrollment.mjs';
import { restoreEnrolledRouteStores, restoreRetiredRouteStores } from '../../../platform/src/route-restoration.mjs';
import { readRouteRecord } from '../../../platform/src/route-record-store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export async function durableEnrollmentFixture(t, selection) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-fresh-installation-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'host'), volumes = join(root, 'volumes'); await mkdir(directory, { mode: 0o700 }); await mkdir(volumes);
  const { source, profile } = prebootFixture(), entry = { ...profile, schema: 2, id: 'durable-candidate', admission: 'candidate', routing: 'durable' };
  const plan = selection || { ...freshRuntimePlan(source, entry), entry }, selected = plan, events = []; let created = false;
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
    if (args[0] === 'run') {
      const paths = { controller: rolePath('controller'), authority: rolePath('route-authority'), enrollment: rolePath('route-enrollment') };
      const helpers = { 'packages/platform/src/import-route-enrollment.mjs': initializeFreshRouteStores,
        'packages/platform/src/import-restored-routes.mjs': restoreEnrolledRouteStores, 'packages/platform/src/import-retired-routes.mjs': restoreRetiredRouteStores };
      const archives = { archive: restoreAppArchiveStores, restore: restoreAppArchiveRecoveryStores };
      const helper = args.at(-2) === 'packages/platform/src/import-app-archive-routes.mjs' ? archives[args.at(-1)] : helpers[args.at(-1)];
      if (!helper) throw new Error('Unexpected stopped route helper');
      return JSON.stringify(await helper(JSON.parse(options.inputText), paths));
    }
    throw new Error('Unexpected Docker mutation');
  };
  const snapshot = () => ({ identity: hash('inventory'), services: Object.fromEntries(Object.keys(plan.config.services).map(name => [name,
    { id: hash(name), running: false, restarting: false, paused: false, status: 'created', exitCode: 0, startedAt: '0001-01-01T00:00:00Z' }])) });
  const options = { run, authorize: async () => plan.entry, ready: async () => {}, recovery: async () => {}, verify: async () => {}, networks: async () => {},
    fresh: async () => { if (created) throw new Error('Resources already exist'); },
    reserve: async (config, opts) => { assert.equal(opts.reserve, true); const file = join(directory, 'compose.json'); await writeFile(file, JSON.stringify(config), { flag: 'wx', mode: 0o600 }); return file; },
    inspect: async () => snapshot(),
    policies: (config, policy) => installDurablePolicies(config, policy, { readVolume, readPolicy: (_image, name, env) => readRuntimePolicy(volumePath(name), env) }),
    routes: (config, policy, binding) => initializeDurableRoutes(config, policy, binding, { run }),
    stores: (config, policy) => readDurableStores(config, policy, { readVolume }) };
  return { root, directory, selected, options, events, snapshot, rolePath, readVolume };
}
