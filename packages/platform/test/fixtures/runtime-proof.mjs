import { createPrivateKey, createPublicKey, sign } from 'node:crypto';

export function fixtureAuthority(seed) {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  return { privateKey, publicKey };
}

// Independent test encoder of the wire contract; never import the verifier's
// field list or message builder when constructing its oracle.
export function signedIdentity(identity, challenge, authority) {
  const fields = [identity.binarySha256, identity.nodeSha256, identity.namespaceSha256, identity.storageSha256, identity.processKeySha256];
  const message = `cells-runtime-identity-v2\n${challenge}\n${JSON.stringify(fields)}`;
  return { ...identity, challenge, publicKey: authority.publicKey, signature: sign(null, Buffer.from(message), authority.privateKey).toString('hex') };
}
