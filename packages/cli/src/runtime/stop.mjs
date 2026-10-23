import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { readStopConfiguration, installationDirectory } from './installation-state.mjs';
import { validateTopology } from '../recovery/bundle.mjs';
import { docker, composeArgs, projectContainers, stopped } from '../recovery/docker.mjs';
import { recoveryLayout } from '../recovery/layout.mjs';

export async function stopRuntimeServices(config, file, options = {}) {
  const command = composeArgs(file, config.name), { replicas } = recoveryLayout(config);
  for (const services of [['workerd', 'controller'], replicas, ['minio', 'bucket-init']]) await docker([...command, 'stop', ...services], options);
}

export async function stopInstallation(project) {
  const config = await readStopConfiguration(project); validateTopology(config);
  const names = Object.values(config.volumes).map(volume => volume.name);
  const before = await retainedVolumes(names), containers = await projectContainers(project);
  assertStopInventory(config, containers);
  await stopRuntimeServices(config, join(installationDirectory(project), 'compose.json'));
  await stopped(project, names);
  const after = await projectContainers(project); assertStopInventory(config, after);
  const retained = await retainedVolumes(names);
  if (before.some(name => !retained.includes(name))) throw new Error('Installation storage disappeared while stopping; retain its configuration and inspect storage');
  return { project, status: 'stopped', backupCreated: false, backgroundPause: 'unchanged', durability: 'not-assessed',
    retainedVolumes: retained, missingVolumes: names.filter(name => !retained.includes(name)).sort(),
    services: after.map(container => ({ service: container.Config.Labels['com.docker.compose.service'], exitCode: container.State.ExitCode, oomKilled: Boolean(container.State.OOMKilled) })).sort((a, b) => a.service.localeCompare(b.service)) };
}

function assertStopInventory(config, containers) {
  const names = containers.map(container => container.Config?.Labels?.['com.docker.compose.service']);
  if (new Set(names).size !== names.length || containers.some((container, index) => container.Config?.Labels?.['com.docker.compose.project'] !== config.name || !Object.hasOwn(config.services, names[index]))) throw new Error('Unexpected containers in enrolled project; inspect them locally before stopping');
}
async function retainedVolumes(names) {
  const existing = new Set((await docker(['volume', 'ls', '--format', '{{.Name}}'])).trim().split('\n'));
  return names.filter(name => existing.has(name)).sort();
}
export async function stopCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { installation: { type: 'string' } } });
  if (positionals.length || !values.installation) throw new Error('Usage: fogd stop --installation PROJECT');
  console.log(JSON.stringify(await stopInstallation(values.installation), null, 2));
}
