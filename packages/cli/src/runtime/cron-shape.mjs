import { isDeepStrictEqual } from 'node:util';
import { privateRuntimeSubnet } from '@fogd/platform/runtime-policy';
const keys = (value, allowed) => value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).every(key => allowed.includes(key));
const bucket = ['S3_ENDPOINT', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'FOGD_BUCKET'];
const transport = ['FOGD_PROFILE', 'FOGD_TLS', 'FOGD_PUBLIC_BIND_ADDRESS'];
const controller = [...bucket, ...transport, 'FOGD_SLOTS', 'FOGD_ADMIN_USER', 'FOGD_ADMIN_PASSWORD', 'FOGD_DEPLOY_TOKEN',
  'FOGD_GATEWAY_TOKEN', 'FOGD_BASE_DOMAIN', 'FOGD_QUEUE_APPS', 'FOGD_MAX_PENDING', 'FOGD_MAX_PENDING_PER_CREDENTIAL',
  'FOGD_MAX_ARTIFACT_BYTES', 'FOGD_MAX_UPLOADS', 'FOGD_DATA_DIR'];
const gateway = [...transport, 'FOGD_SLOTS', 'FOGD_CONTROLLER', 'FOGD_GATEWAY_TOKEN'];

export function assertCronComposeShape(config, profile) {
  const ordinary = Object.fromEntries(Object.entries(config).filter(([key]) => !key.startsWith('x-')));
  if (!keys(ordinary, ['name', 'services', 'volumes', 'networks'])) throw new Error('Unsupported scheduled Compose extension');
  for (const volume of Object.values(config.volumes)) if (!keys(volume, ['name'])) throw new Error('Scheduled restore requires ordinary named volumes');
  assertNetworks(config.networks, profile.networks);
  for (const service of Object.values(config.services)) for (const mount of service.volumes || []) assertMount(mount);
  for (const [name, allowed] of [['controller', controller], ['workerd', gateway], ['bucket-init', bucket], ['minio', ['MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD']]]) {
    if (!keys(config.services[name].environment, allowed)) throw new Error('Unsupported scheduled service environment');
  }
}
function assertMount(mount) {
  if (!keys(mount, ['type', 'source', 'target', 'read_only', 'volume']) || (mount.volume && !keys(mount.volume, ['nocopy']))) throw new Error('Unsupported scheduled volume override');
  if (mount.source === 'tls' && mount.read_only !== true) throw new Error('Scheduled TLS files must be read-only');
}

function assertNetworks(networks, expected) {
  if (expected !== undefined && (!expected || !isDeepStrictEqual(Object.keys(expected).sort(), Object.keys(networks).sort()) || !Object.values(expected).every(privateRuntimeSubnet))) throw new Error('Scheduled network inventory differs');
  for (const [name, network] of Object.entries(networks)) {
    if (!keys(network, ['name', 'ipam'])) throw new Error('Scheduled restore requires ordinary private bridge networks');
    const subnet = expected?.[name];
    if (subnet) {
      if (!privateRuntimeSubnet(subnet) || !isDeepStrictEqual(network.ipam, { config: [{ subnet }] })) throw new Error('Scheduled private network differs from launch policy');
    } else if (network.ipam && Object.keys(network.ipam).length) throw new Error('Unqualified scheduled network settings');
  }
  if (expected && new Set(Object.values(expected)).size !== Object.keys(expected).length) throw new Error('Scheduled private networks overlap');
}
