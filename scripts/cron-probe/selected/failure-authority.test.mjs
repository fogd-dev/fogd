import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { verifyFailureProof, assertFailureLeases } from './failure-authority.mjs';

const policy = { binarySha256: 'b'.repeat(64), bucket: 'test-bucket', storage: { endpoint: 'http://minio:9000', region: 'us-east-1' },
  fleets: [{ id: 'slot-1', prefix: 'app-one', nodes: [{ id: 'node-a', host: 'host-a' }, { id: 'node-b', host: 'host-b' }] }] };
const hash = value => createHash('sha256').update(value).digest('hex');
// Public deterministic test key, unrelated to any installation or operator.
const key = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + '01'.repeat(32), 'hex'), format: 'der', type: 'pkcs8' });
const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
function proof(change = {}) {
  const fields = { binarySha256: policy.binarySha256, nodeSha256: hash('node-a'), namespaceSha256: hash('s3://test-bucket/app-one'),
    storageSha256: hash(JSON.stringify(['s3://test-bucket/app-one', 'http://minio:9000', 'us-east-1'])), processKeySha256: hash(publicKey), ...change };
  const challenge = 'c'.repeat(64), message = `cells-runtime-identity-v2\n${challenge}\n${JSON.stringify(Object.values(fields))}`;
  return { schema: 2, ...fields, challenge, publicKey, signature: sign(null, Buffer.from(message), key).toString('hex') };
}
const keys = { 'node-a': publicKey, 'node-b': '2'.repeat(64) };
const leases = () => [
  { expectedNode: 'node-a', host: 'host-a', node: 'node-a', addr: 'host-a:8081', publicKey, expires_ms: 1100, missing: false },
  { expectedNode: 'node-b', host: 'host-b', node: 'node-b', addr: 'host-b:8081', publicKey: keys['node-b'], expires_ms: 1100, missing: false },
];
test('survivor proof binds the independent node and storage policy', () => {
  const value = verifyFailureProof(policy, 'slot-1', 'node-a', proof(), 'c'.repeat(64));
  assert.deepEqual([value.node, value.host, value.publicKey], ['node-a', 'host-a', publicKey]);
});
for (const [name, change] of [['binary', { binarySha256: 'd'.repeat(64) }], ['namespace', { namespaceSha256: 'd'.repeat(64) }], ['storage origin', { storageSha256: 'd'.repeat(64) }], ['node', { nodeSha256: 'd'.repeat(64) }]]) {
  test(`a valid signature cannot authorize a different ${name}`, () => {
    assert.throws(() => verifyFailureProof(policy, 'slot-1', 'node-a', proof(change), 'c'.repeat(64)));
  });
}
test('an altered signature cannot authorize a survivor', () => {
  const value = proof(); value.signature = (value.signature.startsWith('0') ? '1' : '0') + value.signature.slice(1);
  assert.throws(() => verifyFailureProof(policy, 'slot-1', 'node-a', value, 'c'.repeat(64)));
});
test('expired authority is permitted only for the explicitly stopped node', () => {
  const rows = leases(); rows[0].expires_ms = 900;
  assert.doesNotThrow(() => assertFailureLeases(policy, 'slot-1', rows, keys, 'node-a', 1000));
});
for (const [name, mutate] of [
  ['changed stopped-node key', rows => { rows[0].publicKey = '3'.repeat(64); }],
  ['expired survivor', rows => { rows[1].expires_ms = 1000; }],
  ['wrong lease address', rows => { rows[1].addr = 'other-host:8081'; }],
  ['misattributed identity', rows => { rows[1].node = 'node-a'; }],
  ['missing live node', rows => { rows[1].missing = true; rows[1].node = null; }],
]) test(`post-cut authority refuses ${name}`, () => {
  const rows = leases(); mutate(rows);
  assert.throws(() => assertFailureLeases(policy, 'slot-1', rows, keys, 'node-a', 1000));
});
