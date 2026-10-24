import { fleetNetworkRole } from '../observe/installation.mjs';
import { isDeepStrictEqual } from 'node:util';
import { json, projectContainers } from '../recovery/docker.mjs';
import { checkContainer } from '../recovery/inventory.mjs';
import { checkMounts } from '../recovery/container-isolation.mjs';

const refused = () => new Error('Replica container log scope is unconfirmed; no log command was started');

async function fleetNetwork(installation, fleet) {
  let role;
  try { role = fleetNetworkRole(installation.config, fleet); } catch { throw refused(); }
  return ownedLogNetwork(installation, role);
}

export async function ownedLogNetwork(installation, role) {
  const name = installation.config.networks[role]?.name;
  const networks = await json(['network', 'inspect', name]);
  const network = networks[0];
  if (networks.length !== 1 || !network?.Id || network.Driver !== 'bridge' || network.Scope !== 'local' || network.Name !== name || network.Labels?.['com.docker.compose.project'] !== installation.project || network.Labels?.['com.docker.compose.network'] !== role) throw refused();
  return { name, id: network.Id };
}

export function logContainer(installation, name, containers, image) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw refused();
  const matches = containers.filter(container => container.Config.Labels?.['com.docker.compose.service'] === name);
  if (matches.length !== 1) throw refused();
  const container = matches[0], service = installation.config.services[name];
  if (!/^[a-f0-9]{64}$/.test(container.Id || '') || container.Image !== service.image || container.Config.Image !== service.image || container.Config.Labels?.['com.docker.compose.project'] !== installation.project) throw refused();
  try { checkContainer(service, container, image); checkMounts(service, container, installation.config.volumes); }
  catch { throw refused(); }
  const { Running, Paused, Restarting, StartedAt } = container.State || {};
  if (![Running, Paused, Restarting].every(value => typeof value === 'boolean') || typeof StartedAt !== 'string' || !Number.isFinite(Date.parse(StartedAt))) throw refused();
  return container;
}

function replica(installation, node, containers, image, network) {
  const container = logContainer(installation, node.host, containers, image);
  const attached = Object.entries(container.NetworkSettings?.Networks || {});
  if (attached.length !== 1 || attached[0][0] !== network.name || attached[0][1].NetworkID !== network.id) throw refused();
  const { Running, Paused, Restarting, StartedAt } = container.State;
  return { node: node.host, id: container.Id, startedAt: StartedAt, running: Running, paused: Paused, restarting: Restarting };
}

export async function logScope(installation, selection) {
  const network = await fleetNetwork(installation, selection.fleet), containers = await projectContainers(installation.project);
  const [image] = await json(['image', 'inspect', installation.entry.image]);
  return { network, replicas: selection.fleet.nodes.map(node => replica(installation, node, containers, image, network)) };
}

export const sameLogScope = (before, after) => isDeepStrictEqual(before, after);
