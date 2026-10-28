import assert from 'node:assert/strict';
import { json, stopped } from '../../../packages/cli/src/recovery/docker.mjs';

export function recordRequests(host, request, journal) {
  return async (path, options = {}) => {
    journal.push({ project: host.project, method: options.method || 'GET', app: options.app || null, path, at: Date.now() });
    return request(path, options);
  };
}
export async function retainedInstallations(installations) {
  const volumes = installations.flatMap(host => Object.values(host.config.volumes).map(volume => volume.name));
  assert.equal(installations.length, 4); assert.equal(new Set(volumes).size, volumes.length);
  const inspected = await json(['volume', 'inspect', ...volumes]); assert.deepEqual(inspected.map(volume => volume.Name).sort(), volumes.toSorted());
  for (const host of installations) await stopped(host.project, Object.values(host.config.volumes).map(volume => volume.name));
  return volumes;
}
