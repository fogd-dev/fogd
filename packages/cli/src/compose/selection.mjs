import { isDeepStrictEqual } from 'node:util';
import { json, docker, projectContainers } from '../recovery/docker.mjs';

export function assertReplicaSelection(expected, observed) {
  const replicas = [...new Set(observed.filter(name => /^slot-\d+-[ab]$/.test(name || '')))].sort();
  if (replicas.length && !isDeepStrictEqual(replicas, [...expected].sort())) throw new Error('Existing project has a different fleet layout; use stopped backup and fogd expand into a fresh project');
}
export async function checkFleetSelection(config) {
  const containers = await projectContainers(config.name);
  const names = (await docker(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${config.name}`])).trim().split(/\s+/).filter(Boolean);
  const volumes = names.length ? await json(['volume', 'inspect', ...names]) : [];
  const observed = [...containers.map(c => c.Config.Labels['com.docker.compose.service']), ...volumes.map(v => v.Labels?.['com.docker.compose.volume'])];
  assertReplicaSelection(Object.keys(config.services).filter(name => /^slot-\d+-[ab]$/.test(name)), observed);
}
