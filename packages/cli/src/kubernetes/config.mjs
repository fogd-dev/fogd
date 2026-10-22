import { assertSharedStorageCredentials } from '../shared-storage.mjs';
import { transportPolicy, validateKeypair } from '@fogd/runtime/transport';

function configuredImages(env, pullPolicy) {
  const images = {};
  for (const key of ['RUNTIME', 'MINIO']) {
    const value = env[`FOGD_KUBE_${key}_IMAGE`];
    if (!value || /\s/.test(value) || (pullPolicy !== 'Never' && !/@sha256:[a-f0-9]{64}$/.test(value))) throw new Error(`Set FOGD_KUBE_${key}_IMAGE to a digest-pinned image (or explicitly use preloaded local images)`);
    images[key.toLowerCase()] = value;
  }
  return images;
}

export function kubeSettings(env, keypair) {
  transportPolicy(env);
  if (env.FOGD_PROFILE !== 'shared') throw new Error('Kubernetes manifests require an explicit shared profile');
  if (env.FOGD_BUCKET_ENDPOINT && env.FOGD_BUCKET_ENDPOINT !== 'http://minio:9000') throw new Error('Kubernetes qualification supports only the in-namespace MinIO bucket');
  const namespace = env.FOGD_KUBE_NAMESPACE;
  if (!namespace || namespace.length > 63 || !/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(namespace)) throw new Error('Set FOGD_KUBE_NAMESPACE to a DNS label');
  for (const key of ['FOGD_ADMIN_USER', 'FOGD_ADMIN_PASSWORD', 'FOGD_GATEWAY_TOKEN', 'FOGD_BUCKET_USER', 'FOGD_BUCKET_PASSWORD']) if (!env[key]) throw new Error(`${key} is required`);
  assertSharedStorageCredentials(env.FOGD_PROFILE, env.FOGD_BUCKET_USER, env.FOGD_BUCKET_PASSWORD);
  const pullPolicy = env.FOGD_KUBE_LOCAL_IMAGES === '1' ? 'Never' : 'IfNotPresent';
  const images = configuredImages(env, pullPolicy);
  const { cert, key } = validateKeypair(keypair);
  const slots = [1, 2].map(n => ({ id: `slot-${n}`, prefix: env[`FOGD_SLOT_${n}_PREFIX`] || `slots/slot-${n}`, nodes: [0, 1].map(i => `slot-${n}-${i}`) }));
  if (new Set(slots.map(s => s.prefix)).size !== slots.length || slots.some(s => !/^[a-z0-9/-]+$/.test(s.prefix) || s.prefix.split('/').some(p => !p || p === '..'))) throw new Error('Invalid or duplicate fleet prefixes');
  return { namespace, images, pullPolicy, storageClass: env.FOGD_KUBE_STORAGE_CLASS, keypair: { cert, key }, slots, env };
}
export function bucketEnv(settings) {
  return { S3_ENDPOINT: 'http://minio:9000', AWS_REGION: settings.env.FOGD_BUCKET_REGION || 'us-east-1', FOGD_BUCKET: settings.env.FOGD_BUCKET || 'fogd' };
}
export function privateSettings({ env }) {
  return { FOGD_ADMIN_USER: env.FOGD_ADMIN_USER, FOGD_ADMIN_PASSWORD: env.FOGD_ADMIN_PASSWORD, FOGD_GATEWAY_TOKEN: env.FOGD_GATEWAY_TOKEN,
    AWS_ACCESS_KEY_ID: env.FOGD_BUCKET_USER, AWS_SECRET_ACCESS_KEY: env.FOGD_BUCKET_PASSWORD,
    MINIO_ROOT_USER: env.FOGD_BUCKET_USER, MINIO_ROOT_PASSWORD: env.FOGD_BUCKET_PASSWORD };
}
