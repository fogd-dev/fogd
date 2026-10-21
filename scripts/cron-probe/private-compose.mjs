import { randomUUID } from 'node:crypto';
import { execute } from '../../packages/cli/src/recovery/execute.mjs';
import { restoredConfig } from '../../packages/cli/src/recovery/bundle.mjs';

// Resolve the ordinary two-fleet layout with fresh fixture credentials. No
// installation is started and no operator environment file is consulted.
export async function privateCompose({ project, runtimeImage, storageImage, networks }) {
  const env = Object.fromEntries(['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { COMPOSE_PROJECT_NAME: project, FOGD_RUNTIME_IMAGE: runtimeImage, FOGD_BUCKET_USER: 'preboot-probe',
    FOGD_BUCKET_PASSWORD: randomUUID(), FOGD_ADMIN_PASSWORD: randomUUID(), FOGD_GATEWAY_TOKEN: randomUUID(), FOGD_DEPLOY_TOKEN: randomUUID() });
  const source = JSON.parse(await execute('docker', ['compose', '--env-file', '/dev/null', '-f', 'compose.yaml', 'config', '--format', 'json'], { env }));
  const images = Object.fromEntries(Object.keys(source.services).map(name => [name, name === 'minio' ? storageImage : runtimeImage]));
  const config = restoredConfig(source, project, images);
  for (const service of Object.values(config.services)) delete service.ports;
  for (const [name, service] of Object.entries(config.services)) if (name.startsWith('slot-')) Object.assign(service.environment, {
    CELLD_CLOUD: '0', CELLD_RUNTIME_IDENTITY_LISTEN: '0.0.0.0:8082',
  });
  for (const [name, subnet] of Object.entries(networks)) config.networks[name].ipam = { config: [{ subnet }] };
  return { config, env };
}
