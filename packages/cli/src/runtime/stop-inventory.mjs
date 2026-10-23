import { docker } from '../recovery/docker.mjs';

export function assertStopInventory(config, containers) {
  const names = containers.map(container => container.Config?.Labels?.['com.docker.compose.service']);
  if (new Set(names).size !== names.length || containers.some((container, index) => container.Config?.Labels?.['com.docker.compose.project'] !== config.name || !Object.hasOwn(config.services, names[index]))) throw new Error('Unexpected containers in enrolled project; inspect them locally before stopping');
}
export async function retainedVolumes(names) {
  const existing = new Set((await docker(['volume', 'ls', '--format', '{{.Name}}'])).trim().split('\n'));
  return names.filter(name => existing.has(name)).sort();
}
export function stoppedReport(config, containers, retained) {
  const names = Object.values(config.volumes).map(volume => volume.name);
  return { project: config.name, status: 'stopped', backupCreated: false, backgroundPause: 'unchanged', durability: 'not-assessed',
    retainedVolumes: retained, missingVolumes: names.filter(name => !retained.includes(name)).sort(),
    services: containers.map(container => ({ service: container.Config.Labels['com.docker.compose.service'], exitCode: container.State.ExitCode, oomKilled: Boolean(container.State.OOMKilled) })).sort((a, b) => a.service.localeCompare(b.service)) };
}
