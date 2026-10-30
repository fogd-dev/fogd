import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { supervisePreviewProcess } from './supervisor.mjs';

const roles = ['minio', 'bucket-init', 'slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b', 'controller'];
const refused = () => { throw new Error('Preview backend requires a fixed role and explicit private preview configuration'); };

// These commands do not authorize execution. The host coordinator must first
// verify its signed decision, fresh resources, image, network and capacity.
export function previewBackendCommand(role, input) {
  if (!roles.includes(role) || !input || !['FOGD_PREVIEW_ID', 'FOGD_PREVIEW_STORAGE_PASSWORD'].every(key => Object.hasOwn(input, key) && typeof input[key] === 'string') ||
    !/^[a-f0-9]{32}$/.test(input.FOGD_PREVIEW_ID) || !/^[a-f0-9]{64}$/.test(input.FOGD_PREVIEW_STORAGE_PASSWORD)) refused();
  const id = input.FOGD_PREVIEW_ID, user = `preview-${id.slice(0, 12)}`, password = input.FOGD_PREVIEW_STORAGE_PASSWORD;
  const bucket = `fogd-preview-${id}`;
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin' };
  if (role === 'controller') {
    if (typeof input.FOGD_PREVIEW_GATEWAY_TOKEN !== 'string' || !/^[a-f0-9]{64}$/.test(input.FOGD_PREVIEW_GATEWAY_TOKEN) || typeof input.FOGD_PREVIEW_EXPIRES_AT !== 'string') refused();
    return { executable: '/usr/local/bin/node', args: ['packages/cli/src/preview/control-main.mjs'], cwd: '/app',
      env: { ...env, FOGD_PREVIEW_ID: id, FOGD_PREVIEW_STORAGE_PASSWORD: password,
        FOGD_PREVIEW_GATEWAY_TOKEN: input.FOGD_PREVIEW_GATEWAY_TOKEN, FOGD_PREVIEW_EXPIRES_AT: input.FOGD_PREVIEW_EXPIRES_AT } };
  }
  if (role === 'minio') return { executable: '/usr/local/bin/minio', args: ['server', '/data', '--console-address', ':9001'],
    env: { ...env, MINIO_ROOT_USER: user, MINIO_ROOT_PASSWORD: password, MINIO_BROWSER: 'off', MINIO_UPDATE: 'off' }, cwd: '/app' };
  Object.assign(env, { S3_ENDPOINT: 'http://minio:9000', AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: user, AWS_SECRET_ACCESS_KEY: password,
    AWS_EC2_METADATA_DISABLED: 'true', FOGD_BUCKET: bucket });
  if (role === 'bucket-init') return { executable: '/usr/local/bin/node', args: ['packages/runtime/src/init-bucket.mjs'], env, cwd: '/app' };
  const fleet = role.slice(0, -2);
  Object.assign(env, { CELLD_BUCKET: `s3://${bucket}/previews/${id}/${fleet}`, CELLD_NODE: `preview-${id}-${role}`,
    CELLD_WATCH: '/var/lib/celld/state', CELLD_CLOUD: '0', CELLD_TTL_MS: '10000', CELLD_V8_HEAP_LIMIT_MB: '128',
    CELLD_MAX_RESIDENT_CELLS: '100', CELLD_MAX_REQUEST_BODY_BYTES: '16777216', CELLD_MAX_REQUESTS: '128', CELLD_RUNTIME_IDENTITY_LISTEN: '0.0.0.0:8082' });
  // Fresh native identities require no restart/lease retry loop. Any exit is
  // terminal; a host must inspect it before deciding what can be reclaimed.
  return { executable: '/usr/local/bin/celld', args: ['--trust-forwarded-headers', '--listen', '0.0.0.0:8080', '--internal-listen', '0.0.0.0:8081', '--advertise', `${role}:8081`], env, cwd: '/app' };
}

export async function runPreviewBackend(role, expiresAt, input, signal) {
  return supervisePreviewProcess({ ...previewBackendCommand(role, { ...input, FOGD_PREVIEW_EXPIRES_AT: expiresAt }), expiresAt, signal });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cancellation = new AbortController(), stop = () => cancellation.abort();
  for (const name of ['SIGTERM', 'SIGINT']) process.on(name, stop);
  try {
    if (process.argv.length !== 4) refused();
    const observed = await runPreviewBackend(process.argv[2], process.argv[3], process.env, cancellation.signal);
    console.log(JSON.stringify({ previewBackend: process.argv[2], ...observed }));
    const clean = observed.childExitConfirmed && (['expired', 'cancelled'].includes(observed.outcome) || (observed.outcome === 'exited' && observed.exitCode === 0));
    process.exit(clean ? 0 : 1);
  } catch { console.error('Preview backend launch refused; keep its resources retained and inspect the exact configuration'); process.exit(1); }
}
