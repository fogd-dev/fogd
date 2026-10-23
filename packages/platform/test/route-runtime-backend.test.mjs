import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { backendRouteVerifier } from '../src/route-runtime.mjs';
import { policy, environment } from './fixtures/runtime-policy.mjs';
import { fixtureAuthority, signedIdentity } from './fixtures/runtime-proof.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-route-verifier-')); t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, 'cli-fixture'), bytes = 'declared fixture bytes'; await writeFile(executable, bytes);
  const profile = policy(); profile.binarySha256 = hash(bytes);
  const fleet = profile.fleets[0], authorities = fleet.nodes.map((_, index) => fixtureAuthority(index + 1));
  const members = fleet.nodes.map((node, index) => ({ node: node.id, addr: `${node.host}:8081`, probe_public_key: authorities[index].publicKey, expires_ms: Date.now() + 60000 }));
  const calls = [], backend = { env: environment(), executable, owner: async () => ({ app: 'alpha' }), s3: { async send(command) {
    calls.push(command.constructor.name);
    const prefix = fleet.prefix + '/nodes/';
    if (command.constructor.name === 'ListObjectsV2Command') return { Contents: fleet.nodes.map(node => ({ Key: `${prefix}${node.id}.json` })) };
    assert.equal(command.constructor.name, 'GetObjectCommand');
    const index = fleet.nodes.findIndex(node => `${prefix}${node.id}.json` === command.input.Key); assert.ok(index >= 0);
    return { Body: Readable.from([JSON.stringify(members[index])]) };
  } } };
  const id = '00000000-0000-4000-8000-000000000001', digest = 'b'.repeat(64), selected = { id, digest };
  const controller = { backend, baseDomain: 'localhost', slots: JSON.parse(backend.env.FOGD_SLOTS), state: {
    apps: { alpha: { active: id, slot: fleet.id, route: 'paused' } }, deployments: { [id]: { ...selected, app: 'alpha', status: 'active', step: 'complete', secretRevision: null, version: 'approved-native-version' } },
  } };
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input); calls.push(url.pathname); assert.equal(options.redirect, 'error');
    assert.ok(!options.method || options.method === 'GET'); assert.ok(options.signal instanceof AbortSignal);
    assert.ok(fleet.nodes.some(node => node.host === url.hostname));
    if (url.pathname === '/runtime/identity') {
      assert.equal(url.port, '8082');
      const index = fleet.nodes.findIndex(node => node.host === url.hostname); assert.ok(index >= 0);
      const namespace = `s3://${profile.bucket}/${fleet.prefix}`;
      return Response.json(signedIdentity({ schema: 2, binarySha256: profile.binarySha256, nodeSha256: hash(fleet.nodes[index].id),
        namespaceSha256: hash(namespace), storageSha256: hash(JSON.stringify([namespace, profile.storage.endpoint, profile.storage.region])),
        processKeySha256: hash(authorities[index].publicKey) }, url.searchParams.get('challenge'), authorities[index]));
    }
    if (url.pathname === '/state') { assert.equal(url.port, '8081'); return Response.json({ deployment: { version: 'approved-native-version' } }); }
    assert.equal(url.pathname, '/.well-known/celld/health'); assert.equal(url.port, '8080'); return new Response('{}');
  });
  return { controller, profile, selected, executable, members, calls };
}
test('production adapter verifies real signed challenges, CLI bytes and storage leases around only GET state/health reads', async t => {
  const f = await fixture(t); await backendRouteVerifier(f.controller, f.profile)('alpha', f.selected);
  assert.equal(f.calls.filter(value => value === '/runtime/identity').length, 4);
  assert.equal(f.calls.filter(value => value === '/state').length, 4);
  assert.equal(f.calls.filter(value => value === '/.well-known/celld/health').length, 2);
  assert.equal(f.calls.filter(value => value === 'ListObjectsV2Command').length, 4);
});
test('changed CLI bytes refuse before reading application state or health', async t => {
  const f = await fixture(t), verify = backendRouteVerifier(f.controller, f.profile); await writeFile(f.executable, 'changed bytes');
  await assert.rejects(verify('alpha', f.selected), { code: 'ROUTE_RUNTIME_UNCONFIRMED' });
  assert.equal(f.calls.some(value => value === '/state' || value.endsWith('/health')), false);
});
test('a lease that cannot authenticate its serving process refuses before application reads', async t => {
  const f = await fixture(t); f.members[0].probe_public_key = 'e'.repeat(64);
  await assert.rejects(backendRouteVerifier(f.controller, f.profile)('alpha', f.selected), { code: 'ROUTE_RUNTIME_UNCONFIRMED' });
  assert.equal(f.calls.some(value => value === '/state' || value.endsWith('/health')), false);
});
