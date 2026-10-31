import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes } from '../build-cache/paths.mjs';
import { checkContainer } from '../recovery/inventory.mjs';
import { checkMounts } from '../recovery/container-isolation.mjs';
import { assertContainerPrivileges, assertInstallationExclusion } from '../recovery/installation-isolation.mjs';
import { previewDns, assertPreviewNetwork } from './networks.mjs';
import { validatePreviewPlan, previewPlanSha256 } from './plan.mjs';
import { hostRefusal } from './host-records.mjs';

const empty = value => value == null || typeof value === 'object' && !Object.keys(value).length;
const same = (actual, expected) => { if (!isDeepStrictEqual(actual, expected)) hostRefusal('stopped-graph'); };
const one = (values, key, expected) => {
  const found = values.filter(value => value[key] === expected);
  if (found.length !== 1) hostRefusal('stopped-graph');
  return found[0];
};
const labels = (plan, allocationId) => ({ 'fogd.preview.project': plan.project, 'fogd.preview.config': previewPlanSha256(plan), 'fogd.preview.allocation': allocationId });

// This image check permits stopped allocation only, not runtime execution. The
// independently supplied digest must match; image volumes may not seed storage.
export function assertPreviewAllocationImage(plan, image, expectedImage) {
  if (expectedImage !== plan.request.image || image?.Id !== expectedImage || image.Os !== 'linux' || image.Architecture !== 'arm64' ||
    !image.Config || !empty(image.Config.Volumes) || image.Config.OnBuild?.length || image.Config.Healthcheck) hostRefusal('allocation-image');
}

function volumes(plan, observed, allocationId) {
  const result = {};
  for (const [role, declaration] of Object.entries(plan.volumes)) {
    const value = one(observed.volumes, 'Name', declaration.name);
    if (value.Driver !== 'local' || value.Scope !== 'local' || !empty(value.Options) || typeof value.Mountpoint !== 'string' || !value.Mountpoint.startsWith('/') || !value.CreatedAt) hostRefusal('stopped-graph');
    same(value.Labels, { ...labels(plan, allocationId), 'fogd.preview.volume': role });
    result[role] = { ...value, mountpoint: value.Mountpoint };
  }
  if (new Set(Object.values(result).map(value => value.Mountpoint)).size !== Object.keys(result).length) hostRefusal('stopped-graph');
  return result;
}
function networks(plan, observed, allocationId) {
  const result = {};
  for (const [role, declaration] of Object.entries(plan.networks)) {
    const value = one(observed.networks, 'Name', declaration.name);
    assertPreviewNetwork(declaration, value);
    same(value.Labels, { ...declaration.labels, ...labels(plan, allocationId) });
    result[role] = { name: value.Name, id: value.Id };
  }
  return result;
}
function neverStarted(container) {
  const state = container.State;
  if (state?.Status !== 'created' || state.Running !== false || state.Paused !== false || state.Restarting !== false || state.Dead !== false ||
    state.OOMKilled !== false || !/^0001-01-01T00:00:00(?:\.0+)?Z$/.test(state.StartedAt) || container.RestartCount !== 0) hostRefusal('started-container');
}
function serviceState(role, container, phase) {
  if (['operating', 'stopped'].includes(phase)) {
    observedState(container);
    if (phase === 'stopped' && !previewContainerStopped(container)) hostRefusal('writer-active');
    return;
  }
  if (phase === 'allocated' || role !== 'input-installer') return neverStarted(container);
  installerStopped(container);
}
function installerStopped(container) {
  const state = container.State;
  if (state?.Status !== 'exited' || state.Running !== false || state.Paused !== false || state.Restarting !== false || state.Dead !== false ||
    state.OOMKilled !== false || state.ExitCode !== 0 || state.Pid !== 0 || !Number.isFinite(Date.parse(state.StartedAt)) || Date.parse(state.StartedAt) < Date.parse('2020-01-01') || container.RestartCount !== 0) hostRefusal('installer-exit');
}
export function previewContainerStopped(container) {
  const state = container.State;
  return state?.Running === false && state.Restarting === false && state.Paused === false && state.Pid === 0 && ['created', 'exited'].includes(state.Status);
}
function observedState(container) {
  const state = container.State;
  if (!state || !['Running', 'Paused', 'Restarting', 'Dead', 'OOMKilled'].every(key => typeof state[key] === 'boolean') ||
    state.Paused || state.Restarting || state.Dead || !Number.isInteger(state.Pid) || state.Pid < 0 || !Number.isInteger(state.ExitCode) || state.ExitCode < 0 ||
    !['created', 'running', 'exited'].includes(state.Status) || !Number.isFinite(Date.parse(state.StartedAt)) || container.RestartCount !== 0) hostRefusal('runtime-state');
  if (!processStateMatches(container)) hostRefusal('runtime-state');
}
const processStateMatches = container => container.State.Running ? container.State.Status === 'running' && container.State.Pid > 0 : previewContainerStopped(container);
function limitsAndPorts(plan, service, host) {
  if (plan.schema === 2) same(host.LogConfig, { Type: plan.hardening.logging.driver, Config: plan.hardening.logging.options });
  same([host.Memory, host.NanoCpus, host.PidsLimit, host.ReadonlyRootfs], [service.memoryBytes, service.cpuLimit * 1e9, service.pidsLimit, true]);
  same(host.RestartPolicy, { Name: 'no', MaximumRetryCount: 0 });
  same(host.Dns, [...previewDns.dns]); same(host.DnsOptions, [...previewDns.dns_opt]);
  const ports = service.publish ? { [`${service.publish.target}/tcp`]: [{ HostIp: service.publish.host, HostPort: String(service.publish.port) }] } : {};
  same(host.PortBindings || {}, ports);
  if (host.PublishAllPorts || host.AutoRemove || host.ExtraHosts?.length || host.DnsSearch?.length || host.IpcMode !== 'private') hostRefusal('stopped-graph');
}
function normalizedMount(value) {
  const result = { ...value, ReadOnly: value.ReadOnly || false, VolumeOptions: { ...value.VolumeOptions } };
  if (empty(result.VolumeOptions.DriverConfig)) delete result.VolumeOptions.DriverConfig;
  return result;
}
function declaredMounts(plan, service, container, checkedVolumes) {
  const host = container.HostConfig;
  const expected = service.mounts.map(value => ({ Type: 'volume', Source: plan.volumes[value.volume].name, Target: value.target, ReadOnly: value.readOnly, VolumeOptions: { NoCopy: true } }));
  same((host.Mounts || []).map(normalizedMount).sort((a,b) => a.Target.localeCompare(b.Target)), expected.sort((a,b) => a.Target.localeCompare(b.Target)));
  for (const mount of container.Mounts.filter(value => value.Type !== 'tmpfs')) {
    if (mount.Driver !== 'local' || mount.Source !== Object.values(checkedVolumes).find(value => value.Name === mount.Name)?.Mountpoint) hostRefusal('stopped-graph');
  }
}
function networkless(container, observedNetworks) {
  same(container.HostConfig.NetworkMode, 'none');
  const entries = Object.entries(container.NetworkSettings.Networks);
  if (!entries.length && container.State.Status === 'created') return;
  const network = one(observedNetworks, 'Name', 'none');
  if (network.Driver !== 'null' || network.Scope !== 'local' || entries.length !== 1 || entries[0][0] !== 'none') hostRefusal('stopped-graph');
  const endpoint = entries[0][1];
  const deferred = container.State.Status === 'created' && endpoint.NetworkID === '' && endpoint.EndpointID === '';
  if (endpoint.NetworkID !== network.Id && !deferred || !empty(endpoint.IPAMConfig) || !empty(endpoint.Links) || !empty(endpoint.Aliases)) hostRefusal('stopped-graph');
}
function declaredNetworks(plan, role, container, checkedNetworks, observedNetworks) {
  const service = plan.services[role], host = container.HostConfig;
  if (!service.networks.length) {
    return networkless(container, observedNetworks);
  }
  same(host.NetworkMode, checkedNetworks[service.networks[0]].name);
  same(Object.keys(container.NetworkSettings.Networks).sort(), service.networks.map(key => checkedNetworks[key].name).sort());
  for (const key of service.networks) {
    const endpoint = container.NetworkSettings.Networks[checkedNetworks[key].name];
    if (endpoint.NetworkID !== checkedNetworks[key].id && !(endpoint.NetworkID === '' && endpoint.EndpointID === '')) hostRefusal('stopped-graph');
    if (!empty(endpoint.IPAMConfig) || !empty(endpoint.Links)) hostRefusal('stopped-graph');
    const aliases = new Set([role, ...(service.aliases?.[key] || [])]);
    same(new Set(endpoint.Aliases || []), aliases);
  }
}

function assertCompleteNamespace(plan, observed) {
  for (const [kind, declarations] of [['containers', plan.services], ['volumes', plan.volumes], ['networks', plan.networks]]) {
    const expected = Object.values(declarations).map(value => value.name).sort();
    const found = observed[kind].filter(value => (value.Config?.Labels || value.Labels)?.['fogd.preview.project'] === plan.project ||
      (value.Name || '').replace(/^\//, '').startsWith(plan.project)).map(value => value.Name.replace(/^\//, '')).sort();
    same(found, expected);
  }
}

export function inspectPreviewGraph(input, observed, image, commands, allocationId, created, phase) {
  try {
    if (!['allocated', 'inputs-installed', 'operating', 'stopped'].includes(phase)) hostRefusal('stopped-graph');
    const plan = validatePreviewPlan(input);
    same(observed.host.ID, plan.request.engineId);
    assertCompleteNamespace(plan, observed);
    const checkedVolumes = volumes(plan, observed, allocationId), checkedNetworks = networks(plan, observed, allocationId), containers = {};
    for (const [role, service] of Object.entries(plan.services)) {
      const container = one(observed.containers, 'Name', '/' + service.name), expected = commands[role];
      same(container.Id, created.containers[role]); serviceState(role, container, phase);
      checkContainer(expected.configuration, container, image); checkMounts(expected.configuration, container, plan.volumes);
      same(container.Config.Image, plan.request.image); same(container.Config.Labels, { ...(image.Config.Labels || {}), ...expected.labels });
      same([container.Config.User || '', container.Config.WorkingDir || ''], [image.Config.User || '', image.Config.WorkingDir || '']);
      same(container.Config.OpenStdin || false, role === 'input-installer');
      assertContainerPrivileges(container.HostConfig, service.networks.length ? Object.values(checkedNetworks).map(value => value.name) : ['none']);
      limitsAndPorts(plan, service, container.HostConfig); declaredMounts(plan, service, container, checkedVolumes); declaredNetworks(plan, role, container, checkedNetworks, observed.networks);
      containers[role] = container;
    }
    for (const [role, value] of Object.entries(checkedNetworks)) same(value.id, created.networks[role]);
    for (const container of observed.containers) if (!Object.values(containers).includes(container)) assertInstallationExclusion({ name: plan.project, volumes: plan.volumes }, container, Object.values(containers), checkedVolumes, checkedNetworks);
    const identities = { containers: Object.fromEntries(Object.entries(containers).map(([role, value]) => [role, value.Id])), networks: Object.fromEntries(Object.entries(checkedNetworks).map(([role,value]) => [role,value.id])), volumes: Object.fromEntries(Object.entries(checkedVolumes).map(([role,value]) => [role, { name: value.Name, createdAt: value.CreatedAt, mountpoint: value.Mountpoint }])) };
    const configurationSha256 = hash(jsonBytes(Object.fromEntries(Object.entries(commands).map(([role,value]) => [role,value.configuration]))));
    return { inventorySha256: hash(jsonBytes({ planSha256: previewPlanSha256(plan), allocationId, configurationSha256, identities })), identities };
  } catch { hostRefusal('stopped-graph'); }
}

export function assertStoppedPreviewGraph(input, observed, image, commands, allocationId, created, phase = 'allocated') {
  if (!['allocated', 'inputs-installed'].includes(phase)) hostRefusal('stopped-graph');
  return inspectPreviewGraph(input, observed, image, commands, allocationId, created, phase);
}
