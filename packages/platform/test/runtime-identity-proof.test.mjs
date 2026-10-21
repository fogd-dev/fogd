import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdentityProof, storageOrigin } from '../src/runtime-identity-proof.mjs';

// Shared with the native ed25519-dalek test; fixed independently of the verifier.
const proof = {
  schema: 2, binarySha256: 'a'.repeat(64), nodeSha256: 'b'.repeat(64),
  namespaceSha256: 'c'.repeat(64), storageSha256: 'd'.repeat(64),
  processKeySha256: '27a18c4142f414227b37507c1da6e90ee6d73565eea7686152c067e2ee262ba7',
  publicKey: 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c',
  challenge: '1'.repeat(64),
  signature: '22a4c58f8211ecfae6c372e79b911329965fedae6964414c40f5614dbf69985ca95b688635fd95dc877be9be685e658a164e40a29c1e6d604ef8fd0d3ba7a70a',
};

test('native signature vector verifies the nonce and all five identity claims', () => {
  assert.deepEqual(verifyIdentityProof(proof, '1'.repeat(64)), { schema: 2,
    binarySha256: 'a'.repeat(64), nodeSha256: 'b'.repeat(64), namespaceSha256: 'c'.repeat(64), storageSha256: 'd'.repeat(64),
    processKeySha256: '27a18c4142f414227b37507c1da6e90ee6d73565eea7686152c067e2ee262ba7' });
});

test('replayed or altered proofs never verify', () => {
  for (const alter of [
    value => { value.signature = '0'.repeat(128); },
    value => { value.binarySha256 = '0'.repeat(64); },
    value => { value.nodeSha256 = '0'.repeat(64); },
    value => { value.namespaceSha256 = '0'.repeat(64); },
    value => { value.storageSha256 = '0'.repeat(64); },
    value => { value.processKeySha256 = '0'.repeat(64); },
    value => { value.publicKey = '0'.repeat(64); },
    value => { value.challenge = '2'.repeat(64); },
    value => { value.privateDiagnostic = 'must-not-pass'; },
    value => { value.schema = 1; },
  ]) {
    const changed = structuredClone(proof); alter(changed);
    assert.throws(() => verifyIdentityProof(changed, '1'.repeat(64)));
  }
  assert.throws(() => verifyIdentityProof(proof, '2'.repeat(64)));
});

test('origin normalization retains provider identity and excludes credential-bearing URLs', () => {
  assert.equal(storageOrigin('HTTP://STORAGE:80/'), 'http://storage');
  assert.equal(storageOrigin('https://storage:443'), 'https://storage');
  assert.equal(storageOrigin('https://other:9000/'), 'https://other:9000');
  for (const endpoint of ['ftp://storage', 'http://user:private@storage', 'http://storage/path', 'http://storage?', 'http://storage#']) {
    assert.throws(() => storageOrigin(endpoint));
  }
});
