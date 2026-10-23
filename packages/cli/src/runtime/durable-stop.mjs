import { isDeepStrictEqual } from 'node:util';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { docker, projectContainers, projectName, stopped } from '../recovery/docker.mjs';
import { runtimeFamilies, validateRuntimeFamily } from './catalog.mjs';
import { runtimePolicyForConfig, declaredRuntimeNetworks, selectedRuntimeConfig } from './selection-plan.mjs';
import { installationDirectory } from './installation-state.mjs';
import { acquireStopFence } from './launch-fence.mjs';
import { assertStopInventory, retainedVolumes, stoppedReport } from './stop-inventory.mjs';

const refused = () => Object.assign(new Error('Durable shutdown is unconfirmed; retain installation storage and host records and inspect the operation fence and container state'), { code: 'ROUTE_STOP_UNCONFIRMED' });
const serviceName = container => container.Config.Labels['com.docker.compose.service'];
const isStopped = container => container.State.Running === false && container.State.Restarting === false && container.State.Paused === false && ['created', 'exited'].includes(container.State.Status);
const identity = containers => containers.map(container => [serviceName(container), container.Id, container.Image]).sort((a, b) => a[0].localeCompare(b[0]));

// Shutdown does not execute an image or require healthy runtime policy/storage.
// The independent catalog and exact sealed host plan restrict its target names.
function stopPlan(config, families) {
  projectName(config.name);
  const candidates = families.filter(entry => entry.schema === 2 && entry.routing === 'durable' && entry.image === config.services?.controller?.image);
  if (candidates.length !== 1) throw refused();
  const entry = validateRuntimeFamily(candidates[0]);
  const policy = runtimePolicyForConfig(config, entry, declaredRuntimeNetworks(config));
  if (!isDeepStrictEqual(config, selectedRuntimeConfig(config, entry, policy))) throw refused();
  return policy;
}
function checkedContainers(config, containers, previous) {
  assertStopInventory(config, containers);
  if (containers.some(container => !/^[a-f0-9]{64}$/.test(container.Id) || container.Image !== config.services[serviceName(container)].image || container.Config.Labels['com.docker.compose.oneoff'] !== 'False')) throw refused();
  if (new Set(containers.map(container => container.Id)).size !== containers.length) throw refused();
  if (containers.some(container => !['Running', 'Restarting', 'Paused'].every(key => typeof container.State?.[key] === 'boolean') || !Number.isInteger(container.State?.ExitCode) || typeof container.State?.OOMKilled !== 'boolean')) throw refused();
  if (previous && !isDeepStrictEqual(identity(containers), identity(previous))) throw refused();
  return containers;
}
async function stopGroup(group, containers, run) {
  const ids = group.flatMap(name => containers.filter(container => serviceName(container) === name && !isStopped(container)).map(container => container.Id));
  if (ids.length) await run(['stop', ...ids]);
}

// Only stops already inspected IDs. No Compose operation, image/helper execution,
// resource allocation, data write, marker reset or background pause is performed.
// Launch and stop share one exclusive host marker; an uncertain mutation retains it.
export async function stopDurableInstallation(config, options = {}) {
  const io = { run: docker, families: runtimeFamilies, containers: projectContainers, volumes: retainedVolumes,
    stopped, acquire: acquireStopFence, ...options };
  let fence, stopping = false;
  try {
    const policy = stopPlan(config, io.families());
    fence = await io.acquire(io.directory ?? installationDirectory(config.name), { project: config.name, installation: runtimePolicyIdentity(policy) });
    const names = Object.values(config.volumes).map(volume => volume.name), beforeVolumes = await io.volumes(names);
    const before = checkedContainers(config, await io.containers(config.name));
    await fence.record('stopping'); stopping = true;
    await stopGroup(['workerd'], before, io.run);
    const ingress = checkedContainers(config, await io.containers(config.name), before);
    if (ingress.some(container => serviceName(container) === 'workerd' && !isStopped(container))) throw refused();
    const groups = [['controller'], policy.fleets.flatMap(fleet => fleet.nodes.map(node => node.host)), ['minio', 'bucket-init']];
    for (const group of groups) await stopGroup(group, before, io.run);
    await io.stopped(config.name, names);
    const after = checkedContainers(config, await io.containers(config.name), before), retained = await io.volumes(names);
    if (after.some(container => !isStopped(container)) || beforeVolumes.some(name => !retained.includes(name))) throw refused();
    const report = stoppedReport(config, after, retained);
    await fence.record('complete'); await fence.release();
    return report;
  } catch {
    if (fence && !stopping) await fence.release().catch(() => {});
    throw refused();
  }
}
