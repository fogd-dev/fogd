import { isDeepStrictEqual } from 'node:util';
import { hasRuntimePolicy, runtimePolicyVolume } from './layout.mjs';

export function validateRuntimePolicyVolume(config, fleets) {
  if (!hasRuntimePolicy(config)) return;
  const definition = config.volumes[runtimePolicyVolume];
  const name = `${config.name}_${runtimePolicyVolume}`;
  if (fleets.length !== 2 || !isDeepStrictEqual(definition, { name }) ||
    Object.entries(config.volumes).some(([role, volume]) => role !== runtimePolicyVolume && volume.name === name)) {
    throw new Error('Runtime policy requires a separate canonical two-fleet installation volume');
  }
  const mount = config.services.controller.volumes?.find(m => m.source === runtimePolicyVolume);
  if (!isDeepStrictEqual(mount, { type: 'volume', source: runtimePolicyVolume, target: '/var/lib/fogd-runtime', read_only: true, volume: { nocopy: true } })) {
    throw new Error('Runtime policy requires a read-only controller mount without image seeding');
  }
}

export function validateFleetStorage(config, fleets) {
  const bucket = config.services.controller.environment.FOGD_BUCKET;
  const nodeIds = new Set();
  if (typeof bucket !== 'string' || !bucket) throw new Error('Missing local storage bucket');
  for (const fleet of fleets) for (const name of fleet.replicas) {
    const env = config.services[name].environment || {};
    if (env.S3_ENDPOINT !== 'http://minio:9000' || env.FOGD_BUCKET !== bucket || env.CELLD_BUCKET !== `s3://${bucket}/${fleet.prefix}`) throw new Error('Replica storage differs from the local fleet layout');
    if (typeof env.CELLD_NODE !== 'string' || !env.CELLD_NODE || nodeIds.has(env.CELLD_NODE)) throw new Error('Replica identities must be nonempty and distinct');
    nodeIds.add(env.CELLD_NODE);
  }
  const initializer = config.services['bucket-init'].environment || {};
  if (initializer.S3_ENDPOINT !== 'http://minio:9000' || initializer.FOGD_BUCKET !== bucket) throw new Error('Bucket initializer differs from local storage');
}
export function validateNetworks(config, fleets) {
  const shared = ['control', ...fleets.map(f => `fleet-${f.id.slice(5)}`)].sort();
  if (!isDeepStrictEqual(Object.keys(config.networks || {}).sort(), shared)) throw new Error('Unexpected recovery networks');
  const expected = { minio: shared, controller: shared, workerd: shared, 'bucket-init': ['control'] };
  for (const fleet of fleets) for (const name of fleet.replicas) expected[name] = [`fleet-${fleet.id.slice(5)}`];
  for (const [name, networks] of Object.entries(expected)) {
    if (!isDeepStrictEqual(Object.keys(config.services[name].networks || {}).sort(), networks)) throw new Error('Service network membership differs from the fleet layout');
  }
}
export function validateMounts(config, replicas) {
  const dataDir = config.services.controller.environment.FOGD_DATA_DIR;
  if (dataDir !== undefined && dataDir !== '/var/lib/fogd') throw new Error('Recovery requires the canonical controller data path /var/lib/fogd');
  const expected = { minio: [['bucket', '/data']], controller: [['controller', '/var/lib/fogd']], workerd: [], 'bucket-init': [] };
  if (hasRuntimePolicy(config)) expected.controller.push([runtimePolicyVolume, '/var/lib/fogd-runtime']);
  for (const name of replicas) expected[name] = [[name, '/var/lib/celld']];
  if (Object.hasOwn(config.volumes, 'tls')) for (const name of ['controller', 'workerd']) expected[name].push(['tls', '/var/lib/fogd-tls']);
  for (const [name, mounts] of Object.entries(expected)) {
    const actual = (config.services[name].volumes || []).map(m => [m.source, m.target]).sort();
    if (!isDeepStrictEqual(actual, mounts.sort())) throw new Error('Service volume mapping differs from the fleet layout');
  }
}
