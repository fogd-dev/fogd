import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertContainerPrivileges, assertInstallationExclusion, InstallationIsolationError } from '../recovery/installation-isolation.mjs';
import { docker } from '../recovery/docker.mjs';
import { checkContainer, assertOwnedLocalVolume } from '../recovery/inventory.mjs';
import { checkMounts } from '../recovery/container-isolation.mjs';
import { durableRuntimeConfig, isDurableConfig } from './durable-config.mjs';

const options = { timeoutMs: 15000 };
const id64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const empty = value => value == null || value === '' || (typeof value === 'object' && !Object.keys(value).length);
const sorted = items => [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const clean = path => posix.normalize(path).replace(/(.)\/$/, '$1');
class Refusal extends Error {}
function refuse(reason) { throw new Refusal(reason); }

// Local observation only, not a writer lock: a container created after these
// reads is not seen. Every failure is a fixed reason without Docker output.
export async function inspectDurableInstallation(config, profile, { run = docker } = {}) {
  try {
    const sealed = sealedConfig(config, profile);
    const containers = await allContainers(run);
    const project = containers.filter(c => c.Config?.Labels?.['com.docker.compose.project'] === sealed.name);
    const volumes = await namedVolumes(sealed, run), networks = await namedNetworks(sealed, run);
    const services = await projectServices(sealed, project, volumes, networks, run);
    for (const container of containers) if (!project.includes(container)) assertInstallationExclusion(sealed, container, project, volumes, networks);
    const identity = createHash('sha256').update(canonical({ v: 'fogd-durable-inventory-v1', profile, config: sealed,
      services: Object.fromEntries(Object.entries(services).map(([name, s]) => [name, s.identity])),
      volumes: Object.fromEntries(Object.entries(volumes).map(([key, v]) => [key, v.identity])),
      networks: Object.fromEntries(Object.entries(networks).map(([key, n]) => [key, n.identity])) })).digest('hex');
    return { identity, services: Object.fromEntries(Object.entries(services).map(([name, s]) => [name, s.state])) };
  } catch (error) {
    const refused = new Error(`Durable installation inventory refused: ${error instanceof Refusal || error instanceof InstallationIsolationError ? error.message : 'Docker inventory could not be verified'}`);
    refused.code = 'DURABLE_INVENTORY_REFUSED'; throw refused;
  }
}

function sealedConfig(config, profile) {
  let sealed;
  try { sealed = durableRuntimeConfig(config, profile); } catch { refuse('configuration is not an exactly sealed durable configuration for this profile'); }
  if (!isDurableConfig(config) || !isDeepStrictEqual(config, sealed)) refuse('configuration is not an exactly sealed durable configuration for this profile');
  return sealed;
}

async function readJson(run, args) {
  let output;
  try { output = await run(args, options); } catch { refuse('Docker inventory query failed'); }
  try { const value = JSON.parse(output); if (Array.isArray(value)) return value; } catch {}
  refuse('Docker returned unreadable inventory');
}
// Exactly one answer per requested key, each matched by its own field.
function oneEach(items, keys, field) {
  if (items.length !== keys.length) refuse('Docker inventory is incomplete or duplicated');
  return keys.map(key => { const found = items.filter(item => item?.[field] === key); if (found.length !== 1) refuse('Docker inventory is incomplete or duplicated'); return found[0]; });
}

async function allContainers(run) {
  let output;
  try { output = await run(['ps', '-aq', '--no-trunc'], options); } catch { refuse('Docker inventory query failed'); }
  const ids = String(output).trim().split(/\s+/).filter(Boolean);
  if (!ids.every(id64) || new Set(ids).size !== ids.length) refuse('Docker container inventory is unreadable');
  return ids.length ? oneEach(await readJson(run, ['container', 'inspect', ...ids]), ids, 'Id') : [];
}

async function namedVolumes(config, run) {
  const keys = Object.keys(config.volumes), names = keys.map(key => config.volumes[key].name);
  const found = oneEach(await readJson(run, ['volume', 'inspect', ...names]), names, 'Name'), result = {};
  keys.forEach((key, index) => {
    const volume = found[index];
    try { assertOwnedLocalVolume(config, key, volume); } catch { refuse('installation volume is not owned local project storage'); }
    if (volume.Scope !== 'local' || typeof volume.Mountpoint !== 'string' || !volume.Mountpoint.startsWith('/')) refuse('installation volume is not owned local project storage');
    result[key] = { mountpoint: clean(volume.Mountpoint), identity: { name: volume.Name, createdAt: volume.CreatedAt, mountpoint: volume.Mountpoint } };
  });
  if (new Set(Object.values(result).map(v => v.mountpoint)).size !== keys.length) refuse('installation volumes alias each other');
  return result;
}

async function namedNetworks(config, run) {
  const keys = Object.keys(config.networks), names = keys.map(key => config.networks[key].name);
  const found = oneEach(await readJson(run, ['network', 'inspect', ...names]), names, 'Name'), result = {};
  keys.forEach((key, index) => {
    const declared = config.networks[key], network = found[index];
    checkDeclaredNetwork(declared);
    const subnets = networkSubnets(network);
    checkNetwork(config, key, network);
    if (declared.ipam !== undefined) checkNetworkAddressing(declared.ipam, subnets);
    result[key] = { id: network.Id, name: network.Name, identity: { id: network.Id, name: network.Name, subnets: sorted(subnets) } };
  });
  return result;
}

function checkDeclaredNetwork(declared) {
  if (Object.keys(declared).some(field => !['name', 'ipam', 'driver'].includes(field)) || (declared.driver ?? 'bridge') !== 'bridge') refuse('declared network is not an ordinary local bridge');
}
function networkSubnets(network) {
  const subnets = Array.isArray(network.IPAM?.Config) ? network.IPAM.Config.map(entry => entry?.Subnet) : [null];
  if (subnets.some(subnet => typeof subnet !== 'string')) refuse('installation network differs from its declaration');
  return subnets;
}
// The sealed topology declares no driver options or address-family overrides.
const networkFlags = ['Internal', 'Ingress', 'ConfigOnly', 'EnableIPv6'];
function checkNetwork(config, key, network) {
  const labels = network.Labels || {};
  if (!id64(network.Id) || network.Driver !== 'bridge' || network.Scope !== 'local' || (network.IPAM.Driver ?? 'default') !== 'default') refuse('installation network differs from its declaration');
  if (networkFlags.some(flag => network[flag]) || network.EnableIPv4 === false || !empty(network.Options) || !empty(network.ConfigFrom?.Network)) refuse('installation network differs from its declaration');
  if (labels['com.docker.compose.project'] !== config.name || labels['com.docker.compose.network'] !== key) refuse('installation network differs from its declaration');
}
function checkNetworkAddressing(ipam, subnets) {
  const expected = Array.isArray(ipam?.config) && Object.keys(ipam).every(field => field === 'config') ? ipam.config.map(entry => Object.keys(entry || {}).join() === 'subnet' ? entry.subnet : null) : [null];
  if (!isDeepStrictEqual(sorted(expected), sorted(subnets.filter(subnet => subnet.includes('.'))))) refuse('installation network addressing differs from its declaration');
}

async function projectServices(config, containers, volumes, networks, run) {
  const byService = {};
  for (const container of containers) {
    const labels = container.Config?.Labels || {}, name = labels['com.docker.compose.service'];
    if (!Object.hasOwn(config.services, name) || labels['com.docker.compose.oneoff'] !== 'False' || byService[name]) refuse('project containers do not match the configured services exactly');
    byService[name] = container;
  }
  if (Object.keys(byService).length !== Object.keys(config.services).length) refuse('project containers do not match the configured services exactly');
  for (const [name, container] of Object.entries(byService)) {
    if (!/^sha256:[a-f0-9]{64}$/.test(container.Image || '') || container.Image !== config.services[name].image || container.Config.Image !== container.Image) refuse('container image differs from the pinned configuration');
  }
  const imageIds = [...new Set(Object.values(byService).map(c => c.Image))];
  const images = oneEach(await readJson(run, ['image', 'inspect', ...imageIds]), imageIds, 'Id');
  const result = {};
  for (const [name, service] of Object.entries(config.services)) {
    const container = byService[name], image = images[imageIds.indexOf(container.Image)];
    result[name] = checkService(config, name, service, container, image, volumes, networks);
  }
  return result;
}

function checkService(config, name, service, container, image, volumes, networks) {
  const host = container.HostConfig || {};
  if (!id64(container.Id) || typeof container.Created !== 'string' || !container.Created) refuse('container identity is unreadable');
  checkLaunch(config, service, container, image);
  checkImageSeeding(config, service, host);
  checkVolumeMounts(config, container, volumes);
  assertContainerPrivileges(host, Object.values(networks).map(n => n.name));
  checkRestartAndPorts(service, host);
  const attached = checkServiceNetworks(service, container, host, networks);
  return {
    identity: { id: container.Id, created: container.Created, image: container.Image,
      mounts: sorted(container.Mounts.map(m => [m.Type, m.Name ?? null, m.Destination, m.RW])), networks: sorted(attached) },
    state: serviceState(container),
  };
}
function checkImageSeeding(config, service, host) {
  for (const mount of service.volumes || []) {
    const matches = (host.Mounts || []).filter(actual => actual.Type === 'volume' && actual.Source === config.volumes[mount.source].name && actual.Target === mount.target);
    if (matches.length !== 1 || matches[0].VolumeOptions?.NoCopy !== true) refuse('container volume permits image seeding');
  }
}

function checkLaunch(config, service, container, image) {
  try { checkContainer(service, container, image); checkMounts(service, container, config.volumes); } catch { refuse('container launch configuration differs from the sealed configuration'); }
  if ((container.Config.User ?? '') !== (image.Config?.User ?? '') || (container.Config.WorkingDir ?? '') !== (image.Config?.WorkingDir ?? '')) refuse('container user differs from the pinned image');
}
function checkVolumeMounts(config, container, volumes) {
  for (const mount of container.Mounts) {
    if (mount.Type !== 'volume') continue;
    const key = Object.keys(config.volumes).find(k => config.volumes[k].name === mount.Name);
    if (mount.Driver !== 'local' || clean(mount.Source) !== volumes[key].mountpoint) refuse('container volume mount does not resolve to installation storage');
  }
}
function checkRestartAndPorts(service, host) {
  if (!isDeepStrictEqual(restartPolicy(service.restart), [host.RestartPolicy?.Name || 'no', host.RestartPolicy?.MaximumRetryCount || 0])) refuse('container restart policy differs from the sealed configuration');
  if (host.PublishAllPorts || !isDeepStrictEqual(sorted(declaredPorts(service.ports)), sorted(publishedPorts(host.PortBindings)))) refuse('container published ports differ from the sealed configuration');
}
function checkServiceNetworks(service, container, host, networks) {
  const attached = Object.entries(container.NetworkSettings?.Networks || {});
  const expected = Object.keys(service.networks || {}).map(key => networks[key]);
  const declared = ([attachedName, endpoint]) => expected.some(n => n.name === attachedName &&
    (n.id === endpoint?.NetworkID || deferredEndpoint(container, endpoint))) && empty(endpoint.IPAMConfig) && empty(endpoint.Links);
  if (attached.length !== expected.length || !expected.some(n => n.name === host.NetworkMode) || !attached.every(declared)) refuse('container networks differ from the sealed configuration');
  // Docker can defer endpoint creation until first start. Bind both observations
  // to the separately inspected network, so startup cannot change the identity.
  return attached.map(([name]) => [name, expected.find(n => n.name === name).id]);
}
function deferredEndpoint(container, endpoint) {
  const state = container.State;
  return state?.Status === 'created' && state.Running === false && state.Restarting === false && state.Paused === false &&
    /^0001-01-01T00:00:00(?:\.0+)?Z$/.test(state.StartedAt) && container.RestartCount === 0 &&
    endpoint?.NetworkID === '' && endpoint.EndpointID === '';
}
// StartedAt brackets preflight, so it must be a real date even when stopped.
function serviceState(container) {
  const state = container.State || {};
  if (['Running', 'Restarting', 'Paused'].some(field => typeof state[field] !== 'boolean') || typeof state.Status !== 'string') refuse('container state is unreadable');
  if (typeof state.StartedAt !== 'string' || !state.StartedAt || Number.isNaN(Date.parse(state.StartedAt)) || !Number.isInteger(state.ExitCode) || state.ExitCode < 0) refuse('container state is unreadable');
  return { id: container.Id, running: state.Running, restarting: state.Restarting, paused: state.Paused, status: state.Status, exitCode: state.ExitCode, startedAt: state.StartedAt };
}

function restartPolicy(value = 'no') {
  const [name, count] = String(value).split(':');
  return [name, count === undefined ? 0 : Number(count)];
}
function declaredPorts(ports = []) {
  if (!Array.isArray(ports)) refuse('declared ports are unsupported');
  return ports.map(port => {
    if (!port || typeof port !== 'object' || Object.keys(port).some(key => !['mode', 'host_ip', 'target', 'published', 'protocol'].includes(key)) ||
      !Number.isInteger(port.target) || !/^[0-9]+$/.test(String(port.published ?? ''))) refuse('declared ports are unsupported');
    return [`${port.target}/${port.protocol ?? 'tcp'}`, port.host_ip ?? '', String(port.published)];
  });
}
function publishedPorts(bindings) {
  return Object.entries(bindings || {}).flatMap(([port, list]) => (list || []).map(item => [port, item?.HostIp ?? '', item?.HostPort ?? '']));
}


function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
