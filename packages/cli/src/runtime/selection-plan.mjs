import { randomUUID } from 'node:crypto';
import { validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { storageOrigin } from '@fogd/platform/runtime-identity-proof';
import { fleetLayout, runtimePolicyVolume, hasRuntimePolicy } from '../recovery/layout.mjs';
import { validateTopology } from '../recovery/bundle.mjs';
import { sealRuntimeConfig } from './cron-preboot.mjs';

export function freshRuntimePlan(input, entry, networks, generation = randomUUID()) {
  const config = structuredClone(input); validateTopology(config);
  networks ??= declaredRuntimeNetworks(config);
  if (!/^[a-f0-9-]{36}$/.test(generation)) throw new Error('Invalid installation identity generation');
  for (const fleet of fleetLayout(config)) for (const host of fleet.nodes) {
    if (config.services[host].environment.CELLD_NODE !== host) throw new Error('Fresh runtime enrollment requires template identities; use independently selected restore for existing identities');
    const id = `${host}-${generation}`;
    config.services[host].environment.CELLD_NODE = id;
  }
  const policy = runtimePolicyForConfig(config, entry, networks);
  return { config: selectedRuntimeConfig(config, entry, policy), policy };
}

// Construction validates data; callers still authorize the family and source
// identity independently before installing this policy.
export function runtimePolicyForConfig(config, entry, networks) {
  validateTopology(config);
  const env = config.services.controller.environment;
  return validateRuntimePolicy({ schema: 2, family: entry.id, admission: entry.admission,
    image: entry.image, storageImage: entry.storageImage, binarySha256: entry.binarySha256, supervisorSha256: entry.supervisorSha256,
    controllerArgs: ['packages/platform/src/main.mjs'], bucket: env.FOGD_BUCKET,
    storage: { endpoint: storageOrigin(env.S3_ENDPOINT), region: env.AWS_REGION },
    fleets: fleetLayout(config).map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(host => ({ host, id: config.services[host].environment.CELLD_NODE })) })),
    ...(networks ? { networks } : {}),
  }, env);
}

export function selectedRuntimeConfig(input, entry, policy) {
  const config = structuredClone(input); validateTopology(config);
  if (policy.family !== entry.id || ['image', 'storageImage', 'binarySha256', 'supervisorSha256'].some(key => policy[key] !== entry[key])) throw new Error('Runtime family differs from installation policy');
  if (new Set(Object.values(config.volumes).map(volume => volume.name)).size !== Object.keys(config.volumes).length) throw new Error('Selected runtime requires separate installation data volumes');
  bindImages(config, entry);
  bindNativeDefaults(config);
  bindNativeIdentities(config, policy);
  if (!hasRuntimePolicy(config)) {
    config.volumes[runtimePolicyVolume] = { name: `${config.name}_${runtimePolicyVolume}` };
    config.services.controller.volumes = [...config.services.controller.volumes || [],
      { type: 'volume', source: runtimePolicyVolume, target: '/var/lib/fogd-runtime', read_only: true, volume: { nocopy: true } }];
  }
  if (policy.networks) for (const [name, network] of Object.entries(config.networks)) {
    if (!network.ipam || !Object.keys(network.ipam).length) network.ipam = { config: [{ subnet: policy.networks[name] }] };
  }
  return sealRuntimeConfig(config, policy);
}

function bindNativeIdentities(config, policy) {
  for (const fleet of policy.fleets) for (const node of fleet.nodes) {
    const env = config.services[node.host].environment;
    if (env.CELLD_NODE !== node.host && env.CELLD_NODE !== node.id) throw new Error('Configured native identity differs from the independent installation policy');
    env.CELLD_NODE = node.id;
  }
}

function bindImages(config, entry) {
  for (const [name, service] of Object.entries(config.services)) {
    const expected = name === 'minio' ? entry.storageImage : entry.image;
    const ordinary = name === 'minio' ? 'fogd-minio:local' : 'fogd-runtime:local';
    if (![expected, ordinary].includes(service.image)) throw new Error('Configured image differs from the selected runtime family');
    service.image = expected;
  }
}
function bindNativeDefaults(config) {
  for (const fleet of fleetLayout(config)) for (const host of fleet.nodes) {
    const env = config.services[host].environment;
    if (env.CELLD_TTL_MS !== undefined || env.FOGD_RESTART_DELAY_SECONDS !== undefined) throw new Error('Selected runtime requires native election and supervisor defaults');
    env.CELLD_CLOUD ??= '0'; env.CELLD_RUNTIME_IDENTITY_LISTEN ??= '0.0.0.0:8082';
  }
}

export function declaredRuntimeNetworks(config) {
  if (!Object.values(config.networks).some(network => Object.keys(network.ipam || {}).length)) return undefined;
  return Object.fromEntries(Object.entries(config.networks).map(([name, network]) => [name, network.ipam?.config?.[0]?.subnet]));
}
