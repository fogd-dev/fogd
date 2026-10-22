import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAvailableSubnets } from '../src/runtime/network-availability.mjs';

const planned = ['10.253.180.0/24', '10.253.181.0/24', '10.253.182.0/24'];
const inspected = subnet => [{ IPAM: { Config: [{ Subnet: subnet }] } }];
for (const subnet of ['10.253.180.0/24', '10.253.182.128/25', '10.253.181.255/32', '10.253.0.0/16', '10.0.0.0/8', '0.0.0.0/0']) test(`overlap with ${subnet} refuses before enrollment`, () => {
  assert.throws(() => assertAvailableSubnets(planned, inspected(subnet)), /overlaps an existing Docker subnet/);
});
for (const subnet of ['10.253.179.0/24', '10.253.183.0/24', '172.17.0.0/16', '192.168.0.0/16', 'fd00::/64', '::/0']) test(`unrelated subnet ${subnet} permits planned private networks`, () => {
  assert.equal(assertAvailableSubnets(planned, inspected(subnet)), undefined);
});
for (const network of [{}, { IPAM: {} }, { IPAM: { Config: {} } }, { IPAM: { Config: [{}] } }, ...['private-value', '10.253.180.0/33', '10.253.180.0/24/0', '10.253.180.0', 'fd00::/129', 'fd00::/64/0'].map(subnet => inspected(subnet)[0])]) test(`unreadable IPAM refuses: ${JSON.stringify(network)}`, () => {
  assert.throws(() => assertAvailableSubnets(planned, [network]), error => /Cannot verify/.test(error.message) && !error.message.includes('private-value'));
});
test('empty Docker inventory and explicitly unallocated host/none IPAM permit placement', () => {
  assert.equal(assertAvailableSubnets(planned, []), undefined);
  assert.equal(assertAvailableSubnets(planned, [{ IPAM: { Config: null } }, { IPAM: { Config: [] } }]), undefined);
});
test('every existing subnet is considered, including a second IPAM entry', () => {
  assert.throws(() => assertAvailableSubnets(planned, [{ IPAM: { Config: [{ Subnet: 'fd00::/64' }, { Subnet: '10.253.182.0/24' }] } }]), /overlaps/);
});
