import { createServer } from 'node:net';
import { docker, json } from '../../../packages/cli/src/recovery/docker.mjs';

export async function loopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}

// Run setup sequentially: this observation is not an address-pool reservation.
export async function privateNetworks() {
  const ids = (await docker(['network', 'ls', '-q'])).trim().split('\n').filter(Boolean);
  const networks = ids.length ? await json(['network', 'inspect', ...ids]) : [];
  const used = networks.flatMap(network => (network.IPAM?.Config || []).map(value => ipv4Range(value.Subnet)).filter(Boolean));
  for (let start = 150; start < 240; start += 3) {
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
