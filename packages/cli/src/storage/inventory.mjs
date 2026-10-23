import { posix } from 'node:path';
import { docker, json } from '../recovery/docker.mjs';
import { assertOwnedLocalVolume } from '../recovery/inventory.mjs';

export async function spaceInventory(config) {
  const info = await json(['info', '--format', '{{json .}}'], { timeoutMs: 15000 });
  const root = info.DockerRootDir;
  if (typeof info.ID !== 'string' || !info.ID || info.OSType !== 'linux' || typeof root !== 'string' || !root.startsWith('/') || posix.normalize(root) !== root || /[,\x00-\x1f]/.test(root)) throw new Error('Cannot verify Docker volume backing paths');
  const names = new Set((await docker(['volume', 'ls', '--format', '{{.Name}}'], { timeoutMs: 15000 })).trim().split('\n'));
  const roles = Object.keys(config.volumes).sort();
  if (roles.some(role => typeof config.volumes[role]?.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(config.volumes[role].name))) throw new Error('Invalid enrolled storage name');
  const present = roles.filter(role => names.has(config.volumes[role].name));
  const metadata = present.length ? await json(['volume', 'inspect', ...present.map(role => config.volumes[role].name)], { timeoutMs: 15000 }) : [];
  if (!Array.isArray(metadata) || metadata.length !== present.length) throw new Error('Incomplete Docker volume inventory');
  const volumes = present.map(role => {
    const name = config.volumes[role].name, volume = metadata.find(value => value.Name === name);
    assertOwnedLocalVolume(config, role, volume);
    const mountpoint = posix.join(root, 'volumes', name, '_data');
    if (volume.Mountpoint !== mountpoint || typeof volume.CreatedAt !== 'string' || !volume.CreatedAt) throw new Error('Cannot verify local volume backing path');
    return { role, name, mountpoint, createdAt: volume.CreatedAt };
  });
  return { engine: { id: info.ID, os: info.OSType, architecture: info.Architecture, driver: info.Driver, root }, volumes,
    missing: roles.filter(role => !present.includes(role)).map(role => ({ role, name: config.volumes[role].name })) };
}
