import { config, replicas } from './recovery-layout.mjs';

export function prebootFixture() {
  const source = config(), profile = { schema: 2, image: 'sha256:' + 'a'.repeat(64), storageImage: 'sha256:' + 'd'.repeat(64), binarySha256: 'b'.repeat(64),
    supervisorSha256: 'c'.repeat(64), bucket: 'fogd', storage: { endpoint: 'http://minio:9000', region: 'us-east-1' },
    controllerArgs: ['packages/platform/src/main.mjs'], fleets: JSON.parse(source.services.controller.environment.FOGD_SLOTS).map(fleet => ({
      ...fleet, nodes: fleet.nodes.map(host => ({ host, id: host })),
    })) };
  for (const [name, service] of Object.entries(source.services)) {
    service.image = name === 'minio' ? 'sha256:' + 'd'.repeat(64) : profile.image;
    Object.assign(service.environment, { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'private-user', AWS_SECRET_ACCESS_KEY: 'private-password' });
  }
  delete source.services.controller.environment.TOKEN;
  delete source.services['bucket-init'].environment.TOKEN; delete source.services['bucket-init'].environment.FOGD_SLOTS;
  source.services.workerd.environment = { FOGD_SLOTS: source.services.controller.environment.FOGD_SLOTS, FOGD_CONTROLLER: 'controller:8083', FOGD_GATEWAY_TOKEN: 'private-gateway' };
  source.services.minio.environment = { MINIO_ROOT_USER: 'private-user', MINIO_ROOT_PASSWORD: 'private-password' };
  source.services.controller.command = ['node', 'packages/platform/src/main.mjs'];
  source.services['bucket-init'].command = ['node', 'packages/runtime/src/init-bucket.mjs'];
  for (const host of replicas) {
    const service = source.services[host]; delete service.environment.TOKEN; delete service.environment.FOGD_SLOTS;
    Object.assign(service.environment, { CELLD_WATCH: '/var/lib/celld/state', CELLD_CLOUD: '0', CELLD_RUNTIME_IDENTITY_LISTEN: '0.0.0.0:8082' });
    service.entrypoint = ['celld-supervisor'];
    service.command = ['--trust-forwarded-headers', '--listen', '0.0.0.0:8080', '--internal-listen', '0.0.0.0:8081', '--advertise', `${host}:8081`];
  }
  return { source, profile };
}
