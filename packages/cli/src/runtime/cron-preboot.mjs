import { isDeepStrictEqual } from 'node:util';
import { hasCronHistory } from '@fogd/platform/cron-history';
import { fleetLayout } from '../recovery/layout.mjs';
import { validateTopology } from '../recovery/bundle.mjs';
import { assertCronComposeShape } from './cron-shape.mjs';
import { storageOrigin } from '@fogd/platform/runtime-identity-proof';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const serviceFields = new Set(['image', 'build', 'command', 'entrypoint', 'environment', 'networks', 'volumes', 'depends_on',
  'restart', 'stop_grace_period', 'mem_limit', 'cpus', 'ports', 'pull_policy', 'read_only', 'tmpfs', 'cap_drop', 'security_opt']);
const temporaryMounts = ['/tmp:rw,noexec,nosuid,nodev'];
const nodeEnvironment = new Set(['S3_ENDPOINT', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'FOGD_BUCKET',
  'CELLD_BUCKET', 'CELLD_NODE', 'CELLD_WATCH', 'CELLD_V8_HEAP_LIMIT_MB', 'CELLD_MAX_RESIDENT_CELLS',
  'CELLD_MAX_REQUEST_BODY_BYTES', 'CELLD_MAX_REQUESTS', 'CELLD_RUNTIME_IDENTITY_LISTEN', 'CELLD_CLOUD',
  'CELLD_TTL_MS', 'FOGD_RESTART_DELAY_SECONDS']);

// Only a trusted qualification caller can supply this policy. A snapshot's
// configuration or capability marker is not authority to select a runtime.
export function cronRestoreConfig(state, config, profile) {
  if (!state || !hasCronHistory(state)) return config;
  try {
    assertProfile(profile);
    validateTopology(config);
    assertCronComposeShape(config, profile);
    const fleets = fleetLayout(config), result = structuredClone(config);
    for (const key of Object.keys(result).filter(key => key.startsWith('x-'))) delete result[key];
    assertFleetProfile(fleets, config, profile);
    for (const [name, service] of Object.entries(result.services)) {
      assertService(service);
      sealService(service, name === 'minio' ? profile.storageImage : profile.image);
    }
    assertStorageService(result.services);
    assertController(result.services.controller, profile);
    assertUtilityCommands(result.services, profile);
    for (const fleet of fleets) for (const host of fleet.nodes) {
      const node = profile.fleets.find(item => item.id === fleet.id).nodes.find(item => item.host === host);
      sealNode(result.services[host], host, node.id, fleet.prefix, profile, result.services.controller.environment);
    }
    return result;
  } catch {
    const error = new Error('Scheduled startup requires a matching independently checked runtime profile; ordinary admission remains closed');
    error.code = 'CRON_PREBOOT_REFUSED'; throw error;
  }
}

function assertProfile(profile) {
  assertArtifacts(profile);
  if (!Array.isArray(profile.controllerArgs) || !profile.controllerArgs.length || profile.controllerArgs.some(value => typeof value !== 'string' || !value)) throw new Error('Missing scheduled controller launch policy');
  if (typeof profile.bucket !== 'string' || !profile.bucket || typeof profile.storage?.region !== 'string' || !profile.storage.region) throw new Error('Missing scheduled storage policy');
  storageOrigin(profile.storage.endpoint);
}
function assertArtifacts(profile) {
  if (!profile || profile.schema !== 2 || !['image', 'storageImage'].every(key => /^sha256:[a-f0-9]{64}$/.test(profile[key] || '')) ||
    !digest(profile.binarySha256) || !digest(profile.supervisorSha256) || !Array.isArray(profile.fleets)) throw new Error('Scheduled restore requires an independently checked runtime profile; ordinary admission remains closed');
}
function assertFleetProfile(fleets, config, profile) {
  if (profile.fleets.length !== fleets.length) throw new Error('Scheduled runtime fleet inventory differs');
  const identities = new Set();
  for (const fleet of fleets) {
    const expected = profile.fleets.filter(item => item?.id === fleet.id);
    if (expected.length !== 1 || expected[0].prefix !== fleet.prefix || !Array.isArray(expected[0].nodes) ||
      expected[0].nodes.length !== fleet.nodes.length) throw new Error('Scheduled runtime fleet profile differs');
    for (const host of fleet.nodes) {
      const nodes = expected[0].nodes.filter(node => node?.host === host);
      if (nodes.length !== 1 || typeof nodes[0].id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(nodes[0].id) || identities.has(nodes[0].id) ||
        config.services[host]?.environment?.CELLD_NODE !== nodes[0].id) throw new Error('Scheduled runtime node profile differs');
      identities.add(nodes[0].id);
    }
  }
}
function assertService(service) {
  if (Object.keys(service).some(key => !serviceFields.has(key))) throw new Error('Unsupported scheduled startup service override');
  if (Object.values(service.networks || {}).some(value => value && Object.keys(value).length)) throw new Error('Scheduled startup requires ordinary private service names');
  if ((service.tmpfs || []).length && !isDeepStrictEqual(service.tmpfs, temporaryMounts)) throw new Error('Scheduled startup does not accept custom temporary mounts');
  for (const key of Object.keys(service.environment || {})) {
    if (/^(?:LD_|DYLD_|NODE_|CELLD_REEXEC_)/.test(key) || key === 'PATH' || key === 'BASH_ENV' || key === 'ENV') throw new Error('Scheduled startup refuses process-loading overrides');
  }
}
function sealService(service, image) {
  if (service.image !== image) throw new Error('Scheduled startup requires the checked immutable runtime image');
  delete service.build;
  Object.assign(service, { pull_policy: 'never', read_only: true, tmpfs: [...temporaryMounts],
    cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'] });
}
function assertController(service, profile) {
  assertStorage(service.environment, profile);
  if (Object.keys(service.environment).some(key => key.startsWith('CELLD_'))) throw new Error('Scheduled controller refuses native startup overrides');
  if (service.entrypoint?.length || !isDeepStrictEqual(service.command, ['node', ...profile.controllerArgs])) throw new Error('Scheduled controller command differs from launch policy');
  service.entrypoint = ['/usr/local/bin/node']; service.command = [...profile.controllerArgs];
}
function assertUtilityCommands(services, profile) {
  if (services.workerd.environment.FOGD_CONTROLLER !== 'controller:8083') throw new Error('Scheduled gateway controller address differs');
  assertStorage(services['bucket-init'].environment, profile);
  assertCredentials(services['bucket-init'].environment, services.controller.environment);
  for (const [name, args] of [['bucket-init', ['node', 'packages/runtime/src/init-bucket.mjs']], ['workerd', ['node', 'packages/runtime/src/serve.mjs']]]) {
    const service = services[name];
    if (service.entrypoint?.length || (service.command && !isDeepStrictEqual(service.command, args))) throw new Error('Scheduled utility startup command differs');
    service.entrypoint = ['/usr/local/bin/node']; service.command = args.slice(1);
  }
}
function assertStorage(env, profile) {
  if (env?.FOGD_BUCKET !== profile.bucket || storageOrigin(env?.S3_ENDPOINT) !== storageOrigin(profile.storage.endpoint) ||
    env.AWS_REGION !== profile.storage.region) throw new Error('Scheduled runtime storage differs from launch policy');
  if (Object.keys(env).some(key => key.startsWith('AWS_') && !['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].includes(key))) throw new Error('Scheduled startup refuses unbound AWS provider options');
}
function sealNode(service, host, id, prefix, profile, controller) {
  const env = service.environment;
  assertStorage(env, profile);
  if (Object.keys(env).some(key => !nodeEnvironment.has(key))) throw new Error('Unsupported scheduled node environment');
  if (env.CELLD_BUCKET !== `s3://${profile.bucket}/${prefix}` || env.CELLD_NODE !== id || env.CELLD_WATCH !== '/var/lib/celld/state' ||
    env.CELLD_CLOUD !== '0' || env.CELLD_RUNTIME_IDENTITY_LISTEN !== '0.0.0.0:8082') throw new Error('Scheduled node startup identity differs');
  assertCredentials(env, controller);
  const args = ['--trust-forwarded-headers', '--listen', '0.0.0.0:8080', '--internal-listen', '0.0.0.0:8081', '--advertise', `${host}:8081`];
  if (!isDeepStrictEqual(service.command, args) || ![['celld-supervisor'], ['/usr/local/bin/celld-supervisor']].some(value => isDeepStrictEqual(service.entrypoint, value))) throw new Error('Scheduled native command differs from launch policy');
  service.entrypoint = ['/usr/local/bin/celld-supervisor'];
}

function assertCredentials(env, expected) {
  if (['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].some(key => !expected[key] || env[key] !== expected[key])) throw new Error('Scheduled storage credentials differ');
}
function assertStorageService(services) {
  const service = services.minio, controller = services.controller.environment;
  const args = ['server', '/data', '--console-address', ':9001'];
  if (service.command && !isDeepStrictEqual(service.command, args)) throw new Error('Scheduled storage command differs');
  if (service.entrypoint?.length && ![['minio'], ['/usr/local/bin/minio']].some(value => isDeepStrictEqual(service.entrypoint, value))) throw new Error('Scheduled storage entrypoint differs');
  if (service.environment.MINIO_ROOT_USER !== controller.AWS_ACCESS_KEY_ID || service.environment.MINIO_ROOT_PASSWORD !== controller.AWS_SECRET_ACCESS_KEY) throw new Error('Scheduled storage account differs');
  service.entrypoint = ['/usr/local/bin/minio']; service.command = args;
}
