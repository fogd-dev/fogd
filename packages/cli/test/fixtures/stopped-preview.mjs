import { randomUUID } from 'node:crypto';
import { previewPlanFixture } from './preview-plan.mjs';
import { previewContainerCommands } from '../../src/preview/container-plan.mjs';
import { previewExecutionSha256 } from '../../src/preview/execution-authority.mjs';
import { previewPlanSha256 } from '../../src/preview/plan.mjs';

const id = n => n.toString(16).padStart(64, '0');
export function stoppedPreviewFixture() {
  const f = previewPlanFixture(), allocationId = randomUUID(), { plan } = f;
  const labels = { 'fogd.preview.project': plan.project, 'fogd.preview.config': previewPlanSha256(plan), 'fogd.preview.allocation': allocationId };
  const image = { Id: plan.request.image, Os: 'linux', Architecture: 'arm64', Config: { Env: ['PATH=/usr/bin'], Labels: { 'io.fogd.runtime.mode': 'preview-backend-candidate' } } };
  const networks = Object.entries(plan.networks).map(([role, value], index) => ({ Id: id(index+100), Name: value.name, Driver: 'bridge', Scope: 'local', Internal: value.internal,
    EnableIPv6: false, Ingress: false, ConfigOnly: false, Options: value.driver_opts, Labels: { ...value.labels, ...labels }, IPAM: { Driver: 'default', Config: [{ Subnet: value.ipam.config[0].subnet }] } }));
  const volumes = Object.entries(plan.volumes).map(([role, value]) => ({ Name: value.name, Driver: 'local', Scope: 'local', Options: null, CreatedAt: '2026-10-30T00:00:00Z', Mountpoint: '/var/lib/docker/volumes/'+value.name+'/_data', Labels: { ...labels, 'fogd.preview.volume': role } }));
  const options = { publicKey: f.authority.publicKey, expectedGrantSha256: previewExecutionSha256(f.envelope), secretValues: { storagePassword: f.storagePassword, gatewayToken: f.gatewayToken } };
  const commands = Object.fromEntries(Object.entries(plan.services).map(([role, service]) => [role, previewContainerCommands(plan, f.envelope, { ...options, allocationId, role, secretValues: Object.fromEntries(Object.values(service.secretEnvironment).map(key => [key, options.secretValues[key]])) })]));
  const containers = Object.entries(plan.services).map(([role, service], index) => {
    const expected = commands[role];
    return { Id: id(index+1), Name: '/'+service.name, Image: image.Id, RestartCount: 0, Config: { Image: image.Id, Labels: { ...image.Config.Labels, ...expected.labels },
      Env: ['PATH=/usr/bin', ...Object.entries(expected.configuration.environment).map(([key,value]) => `${key}=${value}`)], Cmd: ['/app/packages/cli/src/preview/backend.mjs',role,f.envelope.grant.expiresAt], Entrypoint: ['/usr/local/bin/node'] },
      State: { Status: 'created', Running: false, Paused: false, Restarting: false, Dead: false, OOMKilled: false, StartedAt: '0001-01-01T00:00:00Z' },
      HostConfig: { Memory: service.memoryBytes, NanoCpus: service.cpuLimit*1e9, PidsLimit: 128, ReadonlyRootfs: true, RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
        Dns: ['127.0.0.1'], DnsOptions: ['timeout:1','attempts:1'], IpcMode: 'private', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Tmpfs: { '/tmp':'rw,noexec,nosuid,nodev' }, NetworkMode: plan.networks[service.networks[0]].name,
        PortBindings: service.publish ? { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: String(service.publish.port) }] } : {},
        Mounts: service.mounts.map(mount => ({ Type: 'volume', Source: plan.volumes[mount.volume].name, Target: mount.target, ReadOnly: mount.readOnly, VolumeOptions: { NoCopy: true } })) },
      Mounts: service.mounts.map(mount => ({ Type: 'volume', Name: plan.volumes[mount.volume].name, Source: volumes.find(value => value.Name===plan.volumes[mount.volume].name).Mountpoint, Driver: 'local', Destination: mount.target, RW: !mount.readOnly })),
      NetworkSettings: { Networks: Object.fromEntries(service.networks.map(key => [plan.networks[key].name, { NetworkID: networks.find(value => value.Name===plan.networks[key].name).Id, EndpointID: '', Aliases: [role,...(service.aliases?.[key]||[])] }])) } };
  });
  const observed = { host: { ID: plan.request.engineId, OSType: 'linux', Architecture: 'aarch64', Driver: 'overlay2', MemTotal: 6*1024**3 }, containers, networks, volumes };
  const created = { containers: Object.fromEntries(Object.keys(plan.services).map((role,index) => [role,id(index+1)])), networks: Object.fromEntries(Object.keys(plan.networks).map((role,index) => [role,id(index+100)])) };
  return { ...f, allocationId, image, commands, observed, created, options };
}
