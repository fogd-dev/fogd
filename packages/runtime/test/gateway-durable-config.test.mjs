import test from 'node:test';
import assert from 'node:assert/strict';
import { durableGatewayConfig } from '../src/gateway-durable-config.mjs';
const policy = { installation: 'a'.repeat(64), slots: ['slot-1', 'slot-2'] };
const slots = [{ id: 'slot-1', nodes: ['slot-1-a', 'slot-1-b'] }, { id: 'slot-2', nodes: ['slot-2-a', 'slot-2-b'] }];
const options = () => ({ policy, slots, authorityPath: '/var/lib/fogd-routes', listen: '*:8080' });
test('durable gateway config mounts only read-only authority and selected fleet services', () => {
  const config = durableGatewayConfig(options());
  assert.ok(config.includes('disk = (path = "/var/lib/fogd-routes", writable = false)'));
  assert.ok(config.includes('gateway-durable.js')); assert.ok(config.includes('route-record.mjs')); assert.ok(config.includes('gateway-forward.mjs'));
  assert.ok(config.includes('slot-2-b:8080')); assert.ok(config.includes('ROUTE_POLICY')); assert.ok(config.includes('network = (allow = [])'));
  assert.equal(config.includes('CONTROLLER'), false); assert.equal(config.includes('GATEWAY_TOKEN'), false);
  assert.equal(config.includes('APP_HOST'), false); assert.equal(config.includes('NODE_A'), false);
});
for (const [name, patch] of [
  ['foreign fleet', { slots: [slots[0], { ...slots[1], id: 'slot-3' }] }],
  ['shared node', { slots: [slots[0], { ...slots[1], nodes: ['slot-1-a', 'slot-2-b'] }] }],
  ['one replica', { slots: [{ ...slots[0], nodes: ['slot-1-a'] }, slots[1]] }],
  ['address injection', { slots: [{ ...slots[0], nodes: ['user@host', 'slot-1-b'] }, slots[1]] }],
  ['unapproved listen address', { listen: '0.0.0.0:8080' }],
  ['out-of-range port', { listen: '*:65536' }],
  ['relative authority directory', { authorityPath: '../private' }],
]) test(`gateway configuration refuses ${name}`, () => {
  assert.throws(() => durableGatewayConfig({ ...options(), ...patch }), /Invalid durable gateway configuration/);
});
test('TLS config uses only separately staged key files', () => {
  const config = durableGatewayConfig({ ...options(), tls: true });
  assert.ok(config.includes('privateKey = embed "key.pem"')); assert.ok(config.includes('certificateChain = embed "cert.pem"'));
  assert.equal(config.includes('http = ()}, service'), false);
});

test('the renderer accepts three independently selected fleets', () => {
  const config = durableGatewayConfig({ ...options(), policy: { ...policy, slots: [...policy.slots, 'slot-3'] }, slots: [...slots, { id: 'slot-3', nodes: ['slot-3-a', 'slot-3-b'] }] });
  assert.ok(config.includes('slot-3-a:8080')); assert.ok(config.includes('slot-3-b:8080'));
});
