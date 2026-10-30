import { posix } from 'node:path';

export class InstallationIsolationError extends Error {}
const refuse = reason => { throw new InstallationIsolationError(reason); };
const empty = value => value == null || value === '' || (typeof value === 'object' && !Object.keys(value).length);

const unprivilegedEmpty = ['CapAdd', 'Devices', 'DeviceRequests', 'DeviceCgroupRules', 'Sysctls', 'Binds', 'VolumesFrom', 'Links', 'PidMode', 'UTSMode', 'UsernsMode'];
const allowedModes = { IpcMode: ['', 'private', 'shareable'], CgroupnsMode: ['', 'private'] };
export function assertContainerPrivileges(host, networkNames) {
  if (host.Privileged || unprivilegedEmpty.some(field => !empty(host[field])) || Object.entries(allowedModes).some(([field, allowed]) => !allowed.includes(host[field] ?? '')) ||
    !networkNames.includes(host.NetworkMode)) refuse('container privileges or namespaces exceed the sealed configuration');
}
// A stopped foreign container can restart later, so its state does not matter.
export function assertInstallationExclusion(config, container, project, volumes, networks) {
  const host = container.HostConfig || {}, names = new Set(Object.values(config.volumes).map(v => v.name));
  const mountpoints = Object.values(volumes).map(v => v.mountpoint);
  const sources = [...(container.Mounts || []).map(m => [m.Type === 'volume' ? m.Name : null, m.Source]),
    ...(host.Mounts || []).map(m => m?.Type === 'volume' ? [m.Source, null] : [null, m?.Source]),
    ...(host.Binds || []).map(bind => { const source = String(bind).split(':')[0]; return source.startsWith('/') ? [null, source] : [source, null]; })];
  if (sources.some(([name, path]) => names.has(name) || (typeof path === 'string' && path && mountpoints.some(mp => overlaps(clean(path), mp))))) refuse('another container mounts installation storage');
  const joined = mode => typeof mode === 'string' && mode.startsWith('container:') && project.some(c => sameContainer(c, mode.slice(10)));
  if ([host.NetworkMode, host.PidMode, host.IpcMode].some(joined) || (host.VolumesFrom || []).some(ref => project.some(c => sameContainer(c, String(ref).split(':')[0])))) refuse('another container joins installation namespaces');
  const ids = new Set(Object.values(networks).map(n => n.id)), networkNames = new Set(Object.values(networks).map(n => n.name));
  if (networkNames.has(host.NetworkMode) || Object.entries(container.NetworkSettings?.Networks || {}).some(([name, endpoint]) => networkNames.has(name) || ids.has(endpoint?.NetworkID))) refuse('another container is attached to installation networks');
  if (container.Config?.Labels?.['fogd.observer.project'] === config.name) refuse('an installation helper container exists');
}
const clean = path => posix.normalize(path).replace(/(.)\/$/, '$1');
const overlaps = (a, b) => a === b || b.startsWith(a === '/' ? '/' : `${a}/`) || a.startsWith(`${b}/`);
const sameContainer = (container, ref) => ref && (container.Id === ref || (ref.length >= 12 && container.Id.startsWith(ref)) || container.Name === `/${ref}`);
