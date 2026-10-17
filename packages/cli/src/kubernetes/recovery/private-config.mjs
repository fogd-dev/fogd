import { isDeepStrictEqual } from 'node:util';

export function validateClaims(claims) {
  for (const claim of claims) {
    if (!isDeepStrictEqual(Object.keys(claim.spec || {}).sort(), ['accessModes', 'resources', 'storageClassName'])) throw new Error('Unsupported snapshot claim fields');
    if (!isDeepStrictEqual(Object.keys(claim.spec.resources || {}), ['requests']) || !isDeepStrictEqual(Object.keys(claim.spec.resources.requests || {}), ['storage'])) throw new Error('Unsupported snapshot storage request');
    if (!/^[1-9]\d*(Ki|Mi|Gi|Ti)$/.test(claim.spec.resources.requests.storage || '')) throw new Error('Unsupported snapshot storage size');
  }
}
export function privateValues(secrets) {
  const privateObject = secrets.items.find(s => s.metadata.name === 'fogd-private');
  const keys = ['FOGD_ADMIN_USER', 'FOGD_ADMIN_PASSWORD', 'FOGD_GATEWAY_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD'];
  return Object.fromEntries(keys.map(key => [key, decode(privateObject?.data?.[key])]));
}
function decode(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Snapshot is missing valid private configuration');
  return Buffer.from(value, 'base64').toString('utf8');
}
export function validatePrivateConfiguration(secrets) {
  privateValues(secrets);
  const encoded = secrets.items.find(s => s.metadata.name === 'fogd-tls')?.data?.['keypair.json'];
  const input = decode(encoded);
  let keypair;
  try { keypair = JSON.parse(input); } catch { throw new Error('Snapshot contains unreadable TLS configuration'); }
  if (typeof keypair.cert !== 'string' || typeof keypair.key !== 'string') throw new Error('Snapshot is missing its TLS keypair');
}
