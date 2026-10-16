import { resource, labels, values, secretEnv, container, stateful, claim, service } from './resources.mjs';
import { bucketEnv } from './config.mjs';

export function memoryQuantity(value, fallback) {
  if (!value) return fallback;
  const docker = /^(\d+)([kmg])$/i.exec(value);
  return docker ? docker[1] + { k: 'Ki', m: 'Mi', g: 'Gi' }[docker[2].toLowerCase()] : value;
}
const bucketKeys = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
const dataMount = path => [{ name: 'data', mountPath: path }];
const tlsMount = { name: 'tls', mountPath: '/var/lib/fogd-tls', readOnly: true };
const tlsVolume = { name: 'tls', secret: { secretName: 'fogd-tls', defaultMode: 0o400 } };
function initialize(settings) {
  return container('bucket-ready', settings.images.runtime, { pullPolicy: settings.pullPolicy,
    command: ['node', 'packages/runtime/src/init-bucket.mjs'], env: [...values(bucketEnv(settings)), ...secretEnv('fogd-private', bucketKeys)] });
}
export function fleet(settings, slot) {
  const env = [...values({ ...bucketEnv(settings), CELLD_BUCKET: `s3://${bucketEnv(settings).FOGD_BUCKET}/${slot.prefix}`,
    CELLD_WATCH: '/var/lib/celld/state', CELLD_V8_HEAP_LIMIT_MB: settings.env.FOGD_CELLD_HEAP_MB || '128', CELLD_MAX_RESIDENT_CELLS: settings.env.FOGD_MAX_RESIDENT_CELLS || '100', CELLD_MAX_REQUEST_BODY_BYTES: settings.env.FOGD_MAX_REQUEST_BODY_BYTES || '16777216', CELLD_MAX_REQUESTS: settings.env.FOGD_MAX_REQUESTS || '128' }),
  ...secretEnv('fogd-private', bucketKeys), { name: 'CELLD_NODE', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } }];
  const main = container('celld', settings.images.runtime, { env, pullPolicy: settings.pullPolicy, port: 8080, memory: memoryQuantity(settings.env.FOGD_CELLD_MEMORY, '512Mi'), cpu: settings.env.FOGD_CELLD_CPUS || '1', mounts: dataMount('/var/lib/celld'),
    command: ['celld-supervisor'], args: ['--trust-forwarded-headers', '--listen', '0.0.0.0:8080', '--internal-listen', '0.0.0.0:8081', '--advertise', '$(CELLD_NODE):8081'] });
  const pod = { initContainers: [initialize(settings)], containers: [main], affinity: { podAntiAffinity: { requiredDuringSchedulingIgnoredDuringExecution: [{ labelSelector: { matchLabels: { 'app.kubernetes.io/name': slot.id } }, topologyKey: 'kubernetes.io/hostname' }] } } };
  const endpoints = slot.nodes.map(name => resource('Service', name, settings.namespace, { spec: { publishNotReadyAddresses: true, selector: { ...labels(slot.id), 'statefulset.kubernetes.io/pod-name': name }, ports: [8080, 8081].map(port => ({ name: `tcp-${port}`, port, targetPort: port })) } }));
  return [...endpoints, service(slot.id, settings.namespace, [8080, 8081], true), stateful(slot.id, settings.namespace, pod, [claim('data', settings.storageClass, '2Gi')], 2)];
}
export function platform(settings, name) {
  const controller = name === 'controller';
  const env = [...values({ ...bucketEnv(settings), FOGD_PROFILE: 'shared', FOGD_TLS: '1', FOGD_PUBLIC_BIND_ADDRESS: '0.0.0.0', FOGD_DEPLOY_TOKEN: '', FOGD_SLOTS: JSON.stringify(settings.slots), FOGD_BASE_DOMAIN: settings.env.FOGD_BASE_DOMAIN || 'localhost', FOGD_CONTROLLER: 'controller:8083', FOGD_MAX_PENDING: settings.env.FOGD_MAX_PENDING || '20', FOGD_MAX_PENDING_PER_CREDENTIAL: settings.env.FOGD_MAX_PENDING_PER_CREDENTIAL || '5', FOGD_MAX_ARTIFACT_BYTES: settings.env.FOGD_MAX_ARTIFACT_BYTES || '268435456', FOGD_MAX_UPLOADS: settings.env.FOGD_MAX_UPLOADS || '2' }),
    ...secretEnv('fogd-private', controller ? [...bucketKeys, 'FOGD_ADMIN_USER', 'FOGD_ADMIN_PASSWORD', 'FOGD_GATEWAY_TOKEN'] : ['FOGD_GATEWAY_TOKEN'])];
  const main = container(name, settings.images.runtime, { env, pullPolicy: settings.pullPolicy, port: controller ? 8082 : 8080,
    command: ['node', controller ? 'packages/platform/src/main.mjs' : 'packages/runtime/src/serve.mjs'],
    mounts: [...(controller ? dataMount('/var/lib/fogd') : []), tlsMount], memory: controller ? '512Mi' : '256Mi' });
  const pod = { volumes: [tlsVolume], containers: [main], ...(controller ? { initContainers: [initialize(settings)] } : {}) };
  return [service(name, settings.namespace, controller ? [8082, 8083] : [8080]), stateful(name, settings.namespace, pod, controller ? [claim('data', settings.storageClass, '2Gi')] : [])];
}
export function bucket(settings) {
  const main = container('minio', settings.images.minio, { pullPolicy: settings.pullPolicy, env: secretEnv('fogd-private', ['MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD']), port: 9000, mounts: dataMount('/data'), memory: memoryQuantity(settings.env.FOGD_MINIO_MEMORY, '768Mi'), cpu: settings.env.FOGD_MINIO_CPUS || '2' });
  return [service('minio', settings.namespace, [9000]), stateful('minio', settings.namespace, { containers: [main] }, [claim('data', settings.storageClass, '8Gi')])];
}
