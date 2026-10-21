import { createHash, createPublicKey, verify } from 'node:crypto';

const identityFields = ['binarySha256', 'nodeSha256', 'namespaceSha256', 'storageSha256', 'processKeySha256'];
const proofKeys = ['schema', ...identityFields, 'challenge', 'publicKey', 'signature'].sort();
const hex = (value, length) => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);

// The signature binds the complete identity and a fresh caller nonce, not merely
// a public key copied out of storage. It is not hardware/runtime attestation.
export function verifyIdentityProof(value, challenge) {
  if (!value || !hex(challenge, 64) || value.challenge !== challenge || value.schema !== 2 ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(proofKeys) ||
    !identityFields.every(field => hex(value[field], 64)) || !hex(value.publicKey, 64) || !hex(value.signature, 128)) throw new Error('Invalid runtime identity proof');
  const processKey = createHash('sha256').update(value.publicKey).digest('hex');
  if (processKey !== value.processKeySha256) throw new Error('Runtime proof authority mismatch');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(value.publicKey, 'hex')]), format: 'der', type: 'spki' });
  const message = `cells-runtime-identity-v2\n${challenge}\n${JSON.stringify(identityFields.map(field => value[field]))}`;
  if (!verify(null, Buffer.from(message), key, Buffer.from(value.signature, 'hex'))) throw new Error('Runtime identity signature refused');
  return { schema: 2, ...Object.fromEntries(identityFields.map(field => [field, value[field]])) };
}

export function storageOrigin(endpoint) {
  if (typeof endpoint !== 'string') throw new Error('Missing storage endpoint');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
    endpoint.includes('?') || endpoint.includes('#') || url.pathname !== '/') throw new Error('Storage identity requires an HTTP(S) origin');
  return url.origin;
}
