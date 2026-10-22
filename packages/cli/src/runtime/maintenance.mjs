import { resolvedCompose } from '../compose/config.mjs';
import { readRuntimeConfiguration } from './installation-state.mjs';
import { hasRuntimePolicy } from '../recovery/layout.mjs';
import { docker, json } from '../recovery/docker.mjs';
import { assertOwnedLocalVolume } from '../recovery/inventory.mjs';

export async function maintenanceConfiguration(env, project) {
  if (project === undefined) return resolvedCompose(env);
  const config = await readRuntimeConfiguration(project);
  if (!hasRuntimePolicy(config)) throw new Error('Explicit installation maintenance requires its independent runtime policy; legacy fallback is refused');
  const names = new Set((await docker(['volume', 'ls', '--format', '{{.Name}}'])).trim().split('\n'));
  if (Object.values(config.volumes).some(volume => !names.has(volume.name))) throw new Error('Enrolled installation storage is incomplete; keep it stopped and retain its recovery inputs');
  const volumes = await json(['volume', 'inspect', ...Object.values(config.volumes).map(volume => volume.name)]);
  if (!Array.isArray(volumes) || volumes.length !== Object.keys(config.volumes).length) throw new Error('Cannot verify enrolled volume ownership');
  for (const [role, volume] of Object.entries(config.volumes)) assertOwnedLocalVolume(config, role, volumes.find(actual => actual.Name === volume.name));
  return config;
}
