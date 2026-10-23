import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { readEnrolledConfiguration, installationDirectory } from './installation-state.mjs';
import { validateTopology } from '../recovery/bundle.mjs';
import { docker, composeArgs, projectContainers, stopped } from '../recovery/docker.mjs';
import { recoveryLayout } from '../recovery/layout.mjs';
import { isDurableConfig } from './durable-config.mjs';
import { stopDurableInstallation } from './durable-stop.mjs';
import { assertStopInventory, retainedVolumes, stoppedReport } from './stop-inventory.mjs';

export async function stopRuntimeServices(config, file, options = {}) {
  const command = composeArgs(file, config.name), { replicas } = recoveryLayout(config);
  for (const services of [['workerd', 'controller'], replicas, ['minio', 'bucket-init']]) await docker([...command, 'stop', ...services], options);
}

export async function stopInstallation(project) {
  const config = await readEnrolledConfiguration(project);
  if (isDurableConfig(config)) return stopDurableInstallation(config);
  validateTopology(config);
  const names = Object.values(config.volumes).map(volume => volume.name);
  const before = await retainedVolumes(names), containers = await projectContainers(project);
  assertStopInventory(config, containers);
  await stopRuntimeServices(config, join(installationDirectory(project), 'compose.json'));
  await stopped(project, names);
  const after = await projectContainers(project); assertStopInventory(config, after);
  const retained = await retainedVolumes(names);
  if (before.some(name => !retained.includes(name))) throw new Error('Installation storage disappeared while stopping; retain its configuration and inspect storage');
  return stoppedReport(config, after, retained);
}
export async function stopCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { installation: { type: 'string' } } });
  if (positionals.length || !values.installation) throw new Error('Usage: fogd stop --installation PROJECT');
  console.log(JSON.stringify(await stopInstallation(values.installation), null, 2));
}
