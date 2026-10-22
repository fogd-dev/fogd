import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyIdentityProof, storageOrigin } from '../../../packages/platform/src/runtime-identity-proof.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
export function verifyFailureProof(policy, slotId, nodeId, proof, challenge) {
  const fleet = policy.fleets.find(value => value.id === slotId), node = fleet?.nodes.find(value => value.id === nodeId);
  assert.ok(node, 'Proof node is outside the independent policy');
  const namespace = `s3://${policy.bucket}/${fleet.prefix}`, claims = verifyIdentityProof(proof, challenge);
  assert.deepEqual(claims, { schema: 2, binarySha256: policy.binarySha256, nodeSha256: hash(node.id), namespaceSha256: hash(namespace),
    storageSha256: hash(JSON.stringify([namespace, storageOrigin(policy.storage.endpoint), policy.storage.region])), processKeySha256: hash(proof.publicKey) });
  return { node: node.id, host: node.host, publicKey: proof.publicKey, challenge, proof };
}
export function assertFailureLeases(policy, slotId, leases, keys, absentId, at) {
  const fleet = policy.fleets.find(value => value.id === slotId); assert.ok(fleet);
  assert.ok(Number.isSafeInteger(at) && at > 0);
  const ids = fleet.nodes.map(node => node.id).sort();
  assert.deepEqual(Object.keys(keys).sort(), ids); assert.ok(Object.values(keys).every(key => /^[a-f0-9]{64}$/.test(key)));
  assert.equal(leases.length, fleet.nodes.length); assert.deepEqual(leases.map(row => row.expectedNode).sort(), ids);
  assert.ok(absentId === null || ids.includes(absentId));
  for (const node of fleet.nodes) {
    const lease = leases.find(row => row.expectedNode === node.id); assert.equal(lease.host, node.host);
    if (lease.missing) {
      assert.equal(node.id, absentId, 'A live expected node lease is missing'); assert.equal(lease.node, null); continue;
    }
    assert.equal(lease.node, node.id); assert.equal(lease.addr, `${node.host}:8081`); assert.equal(lease.publicKey, keys[node.id]);
    assert.ok(Number.isSafeInteger(lease.expires_ms) && lease.expires_ms >= 0);
    if (node.id !== absentId) assert.ok(lease.expires_ms > at, 'Survivor lease is not current');
  }
}
