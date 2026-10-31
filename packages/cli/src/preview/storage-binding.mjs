import { isDeepStrictEqual } from 'node:util';
import { posix } from 'node:path';
import { inspectPreviewStorage } from './storage.mjs';
import { hostRefusal } from './host-records.mjs';

export async function assertCurrentPreviewStorage(plan, runHost, phase = 'any') {
  try {
    if (plan.schema !== 3 || plan.request.storage?.storage?.schema !== 2 || typeof runHost !== 'function') hostRefusal('storage');
    const expected = plan.request.storage, root = expected.storage.mount.target.slice(0, -('/' + plan.project + '/mount').length);
    const current = await inspectPreviewStorage({ root, project: plan.project, engineId: plan.request.engineId, runHost }, { phase });
    if (!isDeepStrictEqual(current, expected)) hostRefusal('storage');
    return current;
  } catch { hostRefusal('storage'); }
}

export function previewStorageAliases(plan) {
  if (plan.schema !== 3) return {};
  return { storageDirectory: { mountpoint: posix.dirname(plan.request.storage.storage.mount.target) },
    storageDevice: { mountpoint: plan.request.storage.storage.loop.name } };
}
export function assertPreviewStorageExclusion(plan, observed) {
  const aliases = Object.values(previewStorageAliases(plan)).map(value => value.mountpoint);
  const overlaps = path => typeof path === 'string' && aliases.some(root => {
    const value = posix.normalize(path);
    return value === root || value.startsWith(root + '/') || root.startsWith(value === '/' ? '/' : value + '/');
  });
  const names = new Set(Object.values(plan.volumes).map(value => value.name));
  if (observed.volumes.some(volume => !names.has(volume.Name) && overlaps(volume.Options?.device)) ||
    observed.containers.some(container => !Object.values(plan.services).some(service => container.Name === '/' + service.name) &&
      container.HostConfig?.Devices?.some(device => overlaps(device.PathOnHost)))) hostRefusal('stopped-graph');
}
