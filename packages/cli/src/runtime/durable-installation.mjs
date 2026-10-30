import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hasDurableRuntimeMode, runtimePolicyIdentity, validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { transportPolicy } from '@fogd/runtime/transport';
import { assertSharedStorageConfiguration } from '../shared-storage.mjs';
import { docker, composeArgs, requireFresh } from '../recovery/docker.mjs';
import { authorizeInstalledPolicy, verifyRuntimeFamily } from './catalog.mjs';
import { durableRuntimeConfig, durablePlanSha256, routeEnrollmentVolume } from './durable-config.mjs';
import { inspectDurableInstallation } from './durable-inventory.mjs';
import { installDurablePolicies } from './durable-policies.mjs';
import { initializeDurableRoutes } from './durable-enrollment.mjs';
import { beginDurableEnrollment } from './enrollment-record.mjs';
import { writeRuntimeConfiguration, assertRuntimeReady } from './installation-state.mjs';
import { assertDockerNetworkAvailability } from './network-availability.mjs';
import { readDurableStores } from './durable-stores.mjs';
import { assertRecoverySourceStopped } from './recovery-source.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const refused = () => Object.assign(new Error('Fresh durable enrollment is unconfirmed; retain all installation resources and enrollment records'), { code: 'DURABLE_INSTALLATION_UNCONFIRMED' });
function stoppedInventory(snapshot, config, previous) {
  if (!hash(snapshot?.identity) || !snapshot.services || !isDeepStrictEqual(Object.keys(snapshot.services).sort(), Object.keys(config.services).sort())) throw refused();
  if (previous && snapshot.identity !== previous.identity) throw refused();
  for (const state of Object.values(snapshot.services)) {
    if (!hash(state.id) || state.running !== false || state.restarting !== false || state.paused !== false || !['created', 'exited'].includes(state.status)) throw refused();
  }
  return snapshot;
}
async function selectedPlan(selected, io) {
  const { config, entry } = selected, policy = validateRuntimePolicy(selected.policy, config.services.controller.environment);
  if (!hasDurableRuntimeMode(policy) || !isDeepStrictEqual(durableRuntimeConfig(config, policy), config)) throw refused();
  if (!isDeepStrictEqual(await io.authorize(policy), entry)) throw refused();
  transportPolicy(config.services.controller.environment); assertSharedStorageConfiguration(config);
  await io.ready(config.name); await io.recovery(config.name); await io.verify(entry);
  await io.fresh(config.name, config); await io.networks(policy.networks);
  return { config, policy, entry };
}

// Fresh resource allocation is authorized only by independent selection and the
// pre-create absence checks. Empty filesystems and helper receipts alone do not.
export async function enrollDurableInstallation(selected, options = {}) {
  return enroll(selected, options);
}

// The stopped restore coordinator alone supplies these tasks. Its relation is
// recorded before resource creation and its data work finishes before completion.
// Tasks are trusted code, never read from a snapshot or public CLI flags.
export async function enrollDurableRestoration(selected, tasks, options = {}) {
  if (typeof tasks?.prepare !== 'function' || typeof tasks?.populate !== 'function') throw refused();
  return enroll(selected, options, tasks);
}

async function restoredStores(context, tasks, io) {
  const receipt = await tasks.populate(context), stores = await io.stores(context.config, context.policy);
  if (receipt?.revision !== '1' || !hash(receipt.sha256) || receipt.sha256 !== stores.authority.sha256 ||
    stores.authority.record.revision !== '1' || stores.authority.record.routes.some(route => route.state !== 'withheld')) throw refused();
}

async function enroll(selected, options, tasks) {
  const io = { run: docker, authorize: authorizeInstalledPolicy, verify: verifyRuntimeFamily, fresh: requireFresh,
    networks: assertDockerNetworkAvailability, reserve: writeRuntimeConfiguration, ready: assertRuntimeReady,
    recovery: assertRecoverySourceStopped,
    begin: beginDurableEnrollment, inspect: inspectDurableInstallation, policies: installDurablePolicies,
    routes: initializeDurableRoutes, stores: readDurableStores, ...options };
  try {
    const { config, policy, entry } = await selectedPlan(selected, io);
    const file = await io.reserve(config, { reserve: true }), command = composeArgs(file, config.name);
    const record = await io.begin(dirname(file), { project: config.name, installation: runtimePolicyIdentity(policy), planSha256: durablePlanSha256(config, policy) });
    const context = { config, policy, entry, file, command };
    if (tasks) await tasks.prepare(context);
    await io.run(['volume', 'create', '--driver', 'local', '--label', `com.docker.compose.project=${config.name}`,
      '--label', `com.docker.compose.volume=${routeEnrollmentVolume}`, config.volumes[routeEnrollmentVolume].name]);
    await io.run([...command, 'create', '--no-build', '--pull', 'never']);
    const first = stoppedInventory(await io.inspect(config, policy, { run: io.run }), config);
    await io.policies(config, policy);
    stoppedInventory(await io.inspect(config, policy, { run: io.run }), config, first);
    const receipt = await io.routes(config, policy, first.identity), stores = await io.stores(config, policy);
    if (receipt.sha256 !== stores.authority.sha256 || stores.authority.record.revision !== '0' || stores.authority.record.routes.length) throw refused();
    if (tasks) await restoredStores({ ...context, inventory: first, initialized: receipt }, tasks, io);
    stoppedInventory(await io.inspect(config, policy, { run: io.run }), config, first);
    // No Docker or runtime writes follow this publication. Another process may
    // now begin retained startup against the completed, independently checked stores.
    await record.complete(first.identity);
    return { config, policy, entry, file, command };
  } catch { throw refused(); }
}
