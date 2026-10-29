import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPrivateNetworks } from './resources.mjs';

const plan = start => ({ control: `10.253.${start}.0/24`, 'fleet-1': `10.253.${start + 1}.0/24`, 'fleet-2': `10.253.${start + 2}.0/24` });
test('qualification allocation retains its historical first choice', () => {
  assert.deepEqual(selectPrivateNetworks([]), plan(150));
});
test('retained fixtures can fill the original range without forcing deletion', () => {
  const occupied = Array.from({ length: 90 }, (_, index) => `10.253.${150 + index}.0/24`);
  assert.deepEqual(selectPrivateNetworks(occupied), plan(240));
});
test('qualification allocation wraps inside the same private pool', () => {
  const occupied = Array.from({ length: 105 }, (_, index) => `10.253.${150 + index}.0/24`);
  assert.deepEqual(selectPrivateNetworks(occupied), plan(0));
});
test('a partially occupied triplet is never allocated', () => {
  assert.deepEqual(selectPrivateNetworks(['10.253.151.0/24']), plan(153));
});
test('broader occupied subnets exclude every overlapping triplet', () => {
  assert.deepEqual(selectPrivateNetworks(['10.253.144.0/20']), plan(162));
});
test('IPv6 and unrelated private networks do not occupy this IPv4 pool', () => {
  assert.deepEqual(selectPrivateNetworks(['fd00::/64', '172.18.0.0/16', undefined]), plan(150));
});
test('a fully occupied pool refuses without choosing an overlapping range', () => {
  assert.throws(() => selectPrivateNetworks(['10.253.0.0/16']));
});
