import { isIP } from 'node:net';
import { docker, json } from '../recovery/docker.mjs';

export async function assertDockerNetworkAvailability(networks) {
  if (!networks) return;
  const options = { timeoutMs: 15000 };
  const ids = (await docker(['network', 'ls', '-q'], options)).trim().split(/\s+/).filter(Boolean);
  if (!ids.every(id => /^[a-f0-9]{12,64}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('Cannot verify Docker network inventory');
  const inspected = ids.length ? await json(['network', 'inspect', ...ids], options) : [];
  if (!Array.isArray(inspected) || inspected.length !== ids.length || !ids.every(id => inspected.filter(network => typeof network?.Id === 'string' && network.Id.startsWith(id)).length === 1)) throw new Error('Docker network inspection did not cover the inventory');
  assertAvailableSubnets(Object.values(networks), inspected);
}

export function assertAvailableSubnets(planned, inspected) {
  const ranges = planned.map(ipv4Range);
  for (const network of inspected) {
    const config = network?.IPAM?.Config;
    if (config !== null && !Array.isArray(config)) throw new Error('Cannot verify existing Docker network subnets');
    for (const entry of config || []) {
      const value = entry?.Subnet;
      if (typeof value !== 'string') throw new Error('Cannot verify existing Docker network subnets');
      const [address, prefix] = value.split('/');
      if (isIP(address) === 6 && /^(?:0|[1-9][0-9]{0,2})$/.test(prefix) && Number(prefix) <= 128 && value.split('/').length === 2) continue;
      const range = ipv4Range(value);
      if (ranges.some(candidate => candidate[0] <= range[1] && range[0] <= candidate[1])) throw new Error('Requested network plan overlaps an existing Docker subnet; choose unused private subnets before enrollment');
    }
  }
}

function ipv4Range(value) {
  if (typeof value !== 'string') throw new Error('Cannot verify Docker IPv4 subnet');
  const [address, prefix] = value.split('/');
  if (isIP(address) !== 4 || !/^(?:0|[1-9][0-9]?)$/.test(prefix) || Number(prefix) > 32 || value.split('/').length !== 2) throw new Error('Cannot verify Docker IPv4 subnet');
  const number = address.split('.').reduce((n, octet) => n * 256 + Number(octet), 0), size = 2 ** (32 - Number(prefix));
  const start = Math.floor(number / size) * size;
  return [start, start + size - 1];
}
