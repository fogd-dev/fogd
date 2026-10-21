import { isDeepStrictEqual } from 'node:util';

export const runtimePolicyVolume = 'runtime-policy';
export const hasRuntimePolicy = config => Object.hasOwn(config.volumes || {}, runtimePolicyVolume);

function parseSlots(input) {
  try { return JSON.parse(input); }
  catch { throw new Error('Unreadable private slot configuration'); }
}
export function fleetLayout(config) {
  const slots = parseSlots(config.services?.controller?.environment?.FOGD_SLOTS);
  const routed = parseSlots(config.services?.workerd?.environment?.FOGD_SLOTS);
  if (!isDeepStrictEqual(slots, routed)) throw new Error('Gateway/controller slot configuration differs');
  if (!Array.isArray(slots) || ![2, 3].includes(slots.length)) throw new Error('Recovery requires two or three local fleets');
  const fleets = slots.map((slot, index) => {
    const id = `slot-${index + 1}`, replicas = ['a', 'b'].map(letter => `${id}-${letter}`);
    if (slot?.id !== id || !isDeepStrictEqual(slot.nodes, replicas)) throw new Error('Recovery requires ordered local fleet addresses');
    if (typeof slot.prefix !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(slot.prefix)) throw new Error('Invalid local fleet storage prefix');
    return { ...slot, replicas };
  });
  if (fleets.some((a, i) => fleets.slice(i + 1).some(b => a.prefix === b.prefix || a.prefix.startsWith(`${b.prefix}/`) || b.prefix.startsWith(`${a.prefix}/`)))) throw new Error('Fleet storage prefixes overlap');
  return fleets;
}
export function recoveryLayout(config) {
  const fleets = fleetLayout(config), replicas = fleets.flatMap(f => f.replicas);
  const services = ['bucket-init', 'controller', 'minio', ...replicas, 'workerd'].sort();
  const archiveVolumes = ['bucket', 'controller', ...replicas, ...(Object.hasOwn(config.volumes || {}, 'tls') ? ['tls'] : [])].sort();
  const volumes = [...archiveVolumes, ...(hasRuntimePolicy(config) ? [runtimePolicyVolume] : [])].sort();
  return { fleets, replicas, services, volumes, archiveVolumes, archives: ['compose.json', 'images.tar', ...archiveVolumes.map(name => `${name}.tar`)].sort() };
}
export const serviceNames = config => recoveryLayout(config).services;
export const volumeNames = config => recoveryLayout(config).volumes;
