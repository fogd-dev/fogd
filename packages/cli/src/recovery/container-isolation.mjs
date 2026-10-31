import { isDeepStrictEqual } from 'node:util';

// Preserve the declared stopped-installation boundary, including mounts Docker
// reports in HostConfig rather than in its ordinary volume inventory.
export function checkIsolation(service, container) {
  const host = container.HostConfig || {};
  if (service.read_only !== undefined && host.ReadonlyRootfs !== service.read_only) throw new Error('Container root filesystem differs from Compose');
  for (const [key, field] of [['cap_drop', 'CapDrop'], ['security_opt', 'SecurityOpt']]) {
    if (service[key] && !isDeepStrictEqual([...service[key]].sort(), [...(host[field] || [])].sort())) throw new Error('Container launch restrictions differ from Compose');
  }
  if (service.read_only && (host.Privileged || host.CapAdd?.length)) throw new Error('Container privilege exceeds the sealed launch configuration');
  checkTemporaryStorage(service, container, host);
}
function checkTemporaryStorage(service, container, host) {
  const expected = temporaryMounts(service);
  if (!isDeepStrictEqual(host.Tmpfs || {}, expected)) throw new Error('Container temporary filesystem differs from Compose');
  for (const mount of container.Mounts || []) {
    if (mount.Type === 'tmpfs' && (!Object.hasOwn(expected, mount.Destination) || !mount.RW)) throw new Error('Unexpected container temporary mount');
  }
}
function temporaryMounts(service) {
  if (!service.tmpfs?.length) return {};
  if (!['/tmp:rw,noexec,nosuid,nodev', '/tmp:rw,noexec,nosuid,nodev,size=33554432,nr_inodes=4096'].some(value => isDeepStrictEqual(service.tmpfs, [value]))) throw new Error('Backup supports only the sealed /tmp temporary filesystem');
  return { '/tmp': service.tmpfs[0].slice('/tmp:'.length) };
}
export function checkMounts(service, container, volumes) {
  const expected = (service.volumes || []).map(mount => [volumes[mount.source].name, mount.target, !mount.read_only]).sort();
  const actual = container.Mounts.filter(mount => mount.Type !== 'tmpfs').map(mount => [mount.Type === 'volume' ? mount.Name : null, mount.Destination, mount.RW]).sort();
  if (!isDeepStrictEqual(expected, actual)) throw new Error('Container volumes or write permissions differ from the resolved configuration');
}
