import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, createHash } from 'node:crypto';
import { executionKeys, validateExecutionGrant, refuseExecution } from './execution-shape.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const bytes = value => Buffer.from(JSON.stringify(canonical(value)) + '\n');
function authority(value, privateKey) {
  const prefix = privateKey ? '-----BEGIN PRIVATE KEY-----' : '-----BEGIN PUBLIC KEY-----';
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith(prefix)) refuseExecution();
  const key = privateKey ? createPrivateKey(value) : createPublicKey(value);
  if (key.asymmetricKeyType !== 'ed25519') refuseExecution();
  return key;
}
export function createPreviewExecutionAuthority() {
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
}
export function signPreviewExecution(grant, privateKey) {
  try {
    const selected = validateExecutionGrant(grant);
    return { grant: selected, signature: sign(null, bytes(selected), authority(privateKey, true)).toString('base64url') };
  } catch { refuseExecution(); }
}
export function verifyPreviewExecution(envelope, publicKey) {
  try {
    executionKeys(envelope, ['grant', 'signature']);
    const grant = validateExecutionGrant(envelope.grant), signature = envelope.signature;
    if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature) || Buffer.from(signature, 'base64url').toString('base64url') !== signature ||
      !verify(null, bytes(grant), authority(publicKey, false), Buffer.from(signature, 'base64url'))) refuseExecution();
    return grant;
  } catch { refuseExecution(); }
}
export function previewExecutionSha256(envelope) {
  executionKeys(envelope, ['grant', 'signature']);
  validateExecutionGrant(envelope.grant);
  if (typeof envelope.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) refuseExecution();
  return createHash('sha256').update(bytes(envelope)).digest('hex');
}
