import { createServer } from 'node:net';
import { docker, json } from '../../../packages/cli/src/recovery/docker.mjs';

export async function loopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}

// Run setup sequentially: this observation is not an address-pool reservation.
export async function privateNetworks(excluded = []) {
  const ids = (await docker(['network', 'ls', '-q'])).trim().split('\n').filter(Boolean);
  const networks = ids.length ? await json(['network', 'inspect', ...ids]) : [];
  return selectPrivateNetworks([...networks.flatMap(network => (network.IPAM?.Config || []).map(value => value.Subnet)), ...excluded]);
}

export function selectPrivateNetworks(subnets) {
  const used = subnets.map(ipv4Range).filter(Boolean);
  // Keep the historical first choice, then search every complete triplet in
  // the same /16. Retained fixtures can occupy more than the original 30 sets.
  for (let index = 0; index < 85; index++) {
    const start = (150 + index * 3) % 255;
    const subnets = [0, 1, 2].map(offset => `10.253.${start + offset}.0/24`);
    if (subnets.every(subnet => !used.some(range => overlaps(ipv4Range(subnet), range)))) {
      return Object.fromEntries(['control', 'fleet-1', 'fleet-2'].map((name, index) => [name, subnets[index]]));
    }
  }
  throw new Error('No unused qualification subnet set found; existing networks were retained');
}
function ipv4Range(subnet) {
  if (!subnet?.includes('.')) return null;
  const [address, bits] = subnet.split('/'), size = 2 ** (32 - Number(bits));
  const value = address.split('.').reduce((sum, byte) => sum * 256 + Number(byte), 0);
  const start = Math.floor(value / size) * size; return [start, start + size - 1];
}
const overlaps = (a, b) => a[0] <= b[1] && b[0] <= a[1];
