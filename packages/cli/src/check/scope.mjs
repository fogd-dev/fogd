import { fleetNetworkRole } from '../observe/installation.mjs';
import { isDeepStrictEqual } from 'node:util';
import { isIPv4 } from 'node:net';
import { json, projectContainers } from '../recovery/docker.mjs';
import { checkContainer } from '../recovery/inventory.mjs';
import { checkMounts } from '../recovery/container-isolation.mjs';

const refused = () => new Error('Application check gateway scope is unconfirmed; no request was sent');
const running = value => value?.Running === true && value.Paused === false && value.Restarting === false;

export function checkHost(installation, app) {
  const domain = installation.config.services.controller.environment.FOGD_BASE_DOMAIN || 'localhost';
  const host = `${app}.${domain}`;
  if (host.length > 253 || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw refused();
  return host;
}

function gatewayNetworkRole({ config, policy }, fleet) {
  if (policy.schema === 2) return 'control';
  if (policy.schema === 3 && policy.routing === 'durable') return fleetNetworkRole(config, fleet);
  throw refused();
}

// Use the inspected gateway's address, never an arbitrary URL or a Docker DNS alias.
export async function checkGatewayScope(installation, fleet) {
  const { config, entry } = installation, service = config.services.workerd;
  const role = gatewayNetworkRole(installation, fleet);
  if (!Object.hasOwn(service.networks, role)) throw refused();
  const network = config.networks[role].name;
  const networks = await json(['network', 'inspect', network]);
  if (networks.length !== 1 || !networks[0].Id || networks[0].Labels?.['com.docker.compose.project'] !== config.name || networks[0].Labels?.['com.docker.compose.network'] !== role) throw refused();
  const containers = (await projectContainers(config.name)).filter(value => value.Config.Labels?.['com.docker.compose.service'] === 'workerd');
  if (containers.length !== 1) throw refused();
  const gateway = containers[0], endpoint = gateway.NetworkSettings?.Networks?.[network];
  if (!gateway.Id || !running(gateway.State) || gateway.Image !== entry.image || gateway.Config.Image !== entry.image || endpoint?.NetworkID !== networks[0].Id || !isIPv4(endpoint?.IPAddress)) throw refused();
  const [image] = await json(['image', 'inspect', entry.image]);
  try { checkContainer(service, gateway, image); checkMounts(service, gateway, config.volumes); }
  catch { throw refused(); }
  if (typeof gateway.State.StartedAt !== 'string' || !Number.isFinite(Date.parse(gateway.State.StartedAt))) throw refused();
  const tls = service.environment.FOGD_TLS === '1';
  return { network, address: endpoint.IPAddress, tls, boundary: { id: gateway.Id, startedAt: gateway.State.StartedAt, address: endpoint.IPAddress } };
}

export const sameGateway = (before, after) => isDeepStrictEqual(before.boundary, after.boundary) && before.network === after.network && before.tls === after.tls;
