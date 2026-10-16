import { readFile } from 'node:fs/promises';
import { X509Certificate, createPrivateKey } from 'node:crypto';

export function transportPolicy(env) {
  const profile = env.FOGD_PROFILE || 'local';
  if (!['local', 'shared'].includes(profile) || !['0', '1'].includes(env.FOGD_TLS || '0')) throw new Error('Invalid fogd profile or TLS setting');
  const tls = env.FOGD_TLS === '1';
  if (profile === 'shared' && !tls) throw new Error('Shared profile requires TLS');
  if (profile === 'shared' && env.FOGD_DEPLOY_TOKEN) throw new Error('Shared profile requires scoped credentials; unset FOGD_DEPLOY_TOKEN for startup (including any scoped client token)');
  const bind = env.FOGD_PUBLIC_BIND_ADDRESS || env.FOGD_BIND_ADDRESS || '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(bind) && profile !== 'shared') throw new Error('Non-loopback ingress requires the shared profile');
  return { profile, tls };
}
export function validateKeypair(value) {
  try {
    if (typeof value?.cert !== 'string' || typeof value?.key !== 'string') throw new Error();
    const cert = new X509Certificate(value.cert), key = createPrivateKey(value.key);
    if (!cert.checkPrivateKey(key) || Date.now() < Date.parse(cert.validFrom) || Date.now() >= Date.parse(cert.validTo)) throw new Error();
    return { cert: value.cert, key: value.key, fingerprint: cert.fingerprint256, expires: cert.validTo };
  } catch { throw new Error('TLS certificate/key must match and be currently valid PEM'); }
}
export async function loadTLS(env) {
  if (env.FOGD_TLS !== '1') return null;
  let value;
  try { value = JSON.parse(await readFile(env.FOGD_TLS_FILE || '/var/lib/fogd-tls/keypair.json', 'utf8')); }
  catch { throw new Error('Cannot read installed TLS keypair; import a certificate before startup'); }
  const { cert, key } = validateKeypair(value);
  return { cert, key, minVersion: 'TLSv1.2' };
}
