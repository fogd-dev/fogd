import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDurableInstallation } from '../src/runtime/durable-inventory.mjs';
import { freshRuntimePlan } from '../src/runtime/selection-plan.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

const hex = (n, c = 'e') => n.toString(16).padStart(8, '0') + c.repeat(56);
const reads = new Set(['ps', 'container', 'image', 'volume', 'network']);

function fixture(subnets) {
  const { source, profile } = prebootFixture();
  source.services.workerd.ports = [{ mode: 'ingress', host_ip: '127.0.0.1', target: 8080, published: '8787', protocol: 'tcp' }];
  source.services.workerd.restart = 'no'; source.services.controller.restart = 'unless-stopped';
  const { config, policy } = freshRuntimePlan(source, { ...profile, id: 'celld-cron-v2-linux-arm64', admission: 'candidate', routing: 'durable' }, subnets);
  const images = Object.fromEntries([...new Set(Object.values(config.services).map(s => s.image))].map(Id => [Id, { Id, Config: { Env: ['PATH=/usr/bin'], Cmd: ['default'], Entrypoint: null, User: 'node', WorkingDir: '/app' } }]));
  const volumes = Object.fromEntries(Object.entries(config.volumes).map(([key, { name }]) => [key, { Name: name, Driver: 'local', Scope: 'local', Options: null, CreatedAt: '2026-10-01T00:00:00Z',
    Mountpoint: `/var/lib/docker/volumes/${name}/_data`, Labels: { 'com.docker.compose.project': config.name, 'com.docker.compose.volume': key } }]));
  const networks = Object.fromEntries(Object.entries(config.networks).map(([key, { name }], i) => [key, { Name: name, Id: hex(900 + i, 'f'), Driver: 'bridge', Scope: 'local', Internal: false,
    IPAM: { Driver: 'default', Config: [{ Subnet: subnets?.[key] ?? `172.30.${i}.0/24`, Gateway: '172.30.0.1' }] }, Labels: { 'com.docker.compose.project': config.name, 'com.docker.compose.network': key } }]));
  const containers = Object.entries(config.services).map(([name, service], i) => {
    const nets = Object.keys(service.networks);
    return { Id: hex(i), Created: '2026-10-02T00:00:00Z', Name: `/original-${name}-1`, Image: service.image,
      Config: { Image: service.image, User: 'node', WorkingDir: '/app', Cmd: service.command, Entrypoint: service.entrypoint,
        Env: ['PATH=/usr/bin', ...Object.entries(service.environment).map(([k, v]) => `${k}=${v}`)],
        Labels: { 'com.docker.compose.project': config.name, 'com.docker.compose.service': name, 'com.docker.compose.oneoff': 'False' } },
      HostConfig: { ReadonlyRootfs: true, Privileged: false, CapAdd: null, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev' },
        NetworkMode: config.networks[nets[0]].name, IpcMode: 'private', CgroupnsMode: 'private', PidMode: '', Binds: null,
        RestartPolicy: { Name: service.restart ?? 'no', MaximumRetryCount: 0 },
        PortBindings: name === 'workerd' ? { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8787' }] } : {} },
      Mounts: (service.volumes || []).map(m => ({ Type: 'volume', Name: config.volumes[m.source].name, Source: volumes[m.source].Mountpoint, Destination: m.target, Driver: 'local', RW: !m.read_only })),
      NetworkSettings: { Networks: Object.fromEntries(nets.map(key => [config.networks[key].name, { NetworkID: networks[key].Id, IPAMConfig: null, IPAddress: '' }])) },
      State: { Status: 'exited', Running: false, Restarting: false, Paused: false, ExitCode: 0, StartedAt: '0001-01-01T00:00:00Z' } };
  });
  return { config, policy, images, volumes, networks, containers };
}

// Answers Docker read commands from the fixture, honoring requested order.
function docker(f, { reverse = false, calls = [] } = {}) {
  return async (args, options) => {
    calls.push({ args, options });
    const order = list => reverse ? [...list].reverse() : list;
    if (args[0] === 'ps') return order(f.containers.map(c => c.Id)).join('\n') + '\n';
    const byKey = { container: [f.containers, 'Id'], image: [Object.values(f.images), 'Id'], volume: [Object.values(f.volumes), 'Name'], network: [Object.values(f.networks), 'Name'] }[args[0]];
    if (!byKey || args[1] !== 'inspect') throw new Error('unexpected docker command');
    return JSON.stringify(order(args.slice(2).flatMap(key => byKey[0].filter(item => item[byKey[1]] === key))));
  };
}
const inspect = (f, run = docker(f)) => inspectDurableInstallation(f.config, f.policy, { run });
const container = (f, name) => f.containers.find(c => c.Config.Labels['com.docker.compose.service'] === name);
const foreign = (f, extra) => ({ Id: hex(500, 'a'), Name: '/other', Created: 'x', Image: 'sha256:' + '9'.repeat(64), Config: { Labels: {} }, HostConfig: { NetworkMode: 'bridge' }, Mounts: [], NetworkSettings: { Networks: { bridge: { NetworkID: hex(1, 'b') } } }, State: { Running: false }, ...extra });

async function refused(f, pattern, run) {
  await assert.rejects(inspect(f, run), error => {
    assert.equal(error.code, 'DURABLE_INVENTORY_REFUSED');
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /private|sha256|original_|\/var\/lib\/docker/);
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('stopped and running inventory share one identity across query order, using only bounded reads', async () => {
  const f = fixture(), calls = [];
  const stopped = await inspectDurableInstallation(f.config, f.policy, { run: docker(f, { calls }) });
  assert.match(stopped.identity, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(stopped.services).sort(), Object.keys(f.config.services).sort());
  assert.deepEqual(stopped.services['bucket-init'], { id: hex(0), running: false, restarting: false, paused: false, status: 'exited', exitCode: 0, startedAt: '0001-01-01T00:00:00Z' });
  assert.ok(calls.every(call => reads.has(call.args[0]) && (call.args[0] === 'ps' || call.args[1] === 'inspect') && call.options.timeoutMs > 0));
  assert.ok(!JSON.stringify(stopped).includes('private'));
  for (const c of f.containers) {
    if (c.Config.Labels['com.docker.compose.service'] === 'bucket-init') continue;
    c.State = { Status: 'running', Running: true, Restarting: false, Paused: false, ExitCode: 0, StartedAt: '2026-10-23T00:00:00Z' };
    for (const endpoint of Object.values(c.NetworkSettings.Networks)) endpoint.IPAddress = '172.30.0.9';
  }
  f.containers.push(foreign(f)); // unrelated container
  const running = await inspectDurableInstallation(f.config, f.policy, { run: docker(f, { reverse: true }) });
  assert.equal(running.identity, stopped.identity);
  assert.equal(running.services.workerd.running, true);
  assert.equal(running.services.workerd.startedAt, '2026-10-23T00:00:00Z');
});

test('identity binds container, volume and network identity', async () => {
  const base = (await inspect(fixture())).identity;
  for (const alter of [f => { container(f, 'minio').Id = hex(77); }, f => { f.volumes.bucket.CreatedAt = '2026-10-03T00:00:00Z'; },
    f => { f.networks.control.Id = hex(78, 'f'); for (const c of f.containers) if (c.NetworkSettings.Networks.original_control) c.NetworkSettings.Networks.original_control.NetworkID = hex(78, 'f'); }]) {
    const f = fixture(); alter(f); assert.notEqual((await inspect(f)).identity, base);
  }
});

test('refuses unsealed configuration, wrong images and a user that is not from the pinned image', async () => {
  let f = fixture(); f.config.services.workerd.environment.EXTRA = '1'; await refused(f, /sealed durable configuration/);
  f = fixture(); container(f, 'controller').Image = 'sha256:' + '1'.repeat(64); await refused(f, /image/);
  f = fixture(); container(f, 'controller').Config.Image = 'fogd-runtime:local'; await refused(f, /image/);
  f = fixture(); container(f, 'minio').Config.User = 'root'; await refused(f, /user/);
  f = fixture(); container(f, 'controller').Config.Env.push('NODE_OPTIONS=--require=/tmp/x'); await refused(f, /launch configuration/);
  f = fixture(); container(f, 'workerd').Config.Cmd = ['sh']; await refused(f, /launch configuration/);
});

test('refuses missing, duplicate and extra project containers and incomplete inventory', async () => {
  let f = fixture(); f.containers = f.containers.filter(c => c.Config.Labels['com.docker.compose.service'] !== 'bucket-init'); await refused(f, /configured services/);
  f = fixture(); f.containers.push({ ...structuredClone(container(f, 'workerd')), Id: hex(60) }); await refused(f, /configured services/);
  f = fixture(); f.containers.push({ ...structuredClone(container(f, 'workerd')), Id: hex(61) }); f.containers.at(-1).Config.Labels['com.docker.compose.service'] = 'debug'; await refused(f, /configured services/);
  f = fixture(); container(f, 'workerd').Config.Labels['com.docker.compose.oneoff'] = 'True'; await refused(f, /configured services/);
  f = fixture(); const run = docker(f);
  await refused(f, /unreadable/, async (args, o) => args[0] === 'ps' ? `${hex(0)}\n${hex(0)}\n` : run(args, o));
  await refused(f, /incomplete/, async (args, o) => args[0] === 'volume' ? JSON.stringify(Object.values(f.volumes).slice(1)) : run(args, o));
  await refused(f, /unreadable/, async (args, o) => args[0] === 'network' ? 'not json' : run(args, o));
  f = fixture(); f.volumes.bucket.Labels['com.docker.compose.project'] = 'other'; await refused(f, /owned local/);
  f = fixture(); f.volumes.bucket.Mountpoint = f.volumes.controller.Mountpoint; await refused(f, /alias/);
});

test('refuses foreign stopped mounts, bind aliases, namespace joins and helpers', async () => {
  const cases = [
    f => foreign(f, { Mounts: [{ Type: 'volume', Name: 'original_route-authority', Source: '/elsewhere', Destination: '/d', RW: false }] }),
    f => foreign(f, { HostConfig: { NetworkMode: 'bridge', Binds: ['original_bucket:/d:ro'] } }),
    f => foreign(f, { Mounts: [{ Type: 'bind', Source: f.volumes['gateway-policy'].Mountpoint + '/', Destination: '/d', RW: true }] }),
    f => foreign(f, { Mounts: [{ Type: 'bind', Source: '/var/lib/docker/volumes', Destination: '/d', RW: false }] }),
    f => foreign(f, { Mounts: [{ Type: 'bind', Source: f.volumes.controller.Mountpoint + '/db', Destination: '/d', RW: false }] }),
    f => foreign(f, { HostConfig: { NetworkMode: `container:${hex(3).slice(0, 12)}` } }),
    f => foreign(f, { HostConfig: { NetworkMode: 'bridge', PidMode: 'container:original-controller-1' } }),
    f => foreign(f, { NetworkSettings: { Networks: { original_control: { NetworkID: f.networks.control.Id } } } }),
    f => foreign(f, { Config: { Labels: { 'fogd.observer.project': 'original' } } }),
  ];
  for (const build of cases) { const f = fixture(); f.containers.push(build(f)); await refused(f, /another container|helper/); }
});

test('refuses mount drift, unsafe networking, privileges, restart and port deviations', async () => {
  const cases = [
    [f => { container(f, 'workerd').Mounts[0].RW = true; }, /launch configuration/],
    [f => { container(f, 'controller').Mounts.push({ Type: 'bind', Source: '/etc', Destination: '/host', RW: false }); }, /launch configuration/],
    [f => { container(f, 'minio').Mounts[0].Source = '/srv/other'; }, /installation storage/],
    [f => { container(f, 'workerd').HostConfig.NetworkMode = 'host'; }, /privileges or namespaces/],
    [f => { container(f, 'controller').HostConfig.PidMode = 'host'; }, /privileges or namespaces/],
    [f => { container(f, 'controller').HostConfig.UsernsMode = 'host'; }, /privileges or namespaces/],
    [f => { container(f, 'controller').HostConfig.IpcMode = 'host'; }, /privileges or namespaces/],
    [f => { container(f, 'minio').HostConfig.Devices = [{ PathOnHost: '/dev/kvm' }]; }, /privileges or namespaces/],
    [f => { container(f, 'slot-1-a').HostConfig.Privileged = true; }, /launch configuration|privileges/],
    [f => { container(f, 'slot-1-a').HostConfig.CapAdd = ['NET_ADMIN']; }, /launch configuration|privileges/],
    [f => { container(f, 'workerd').HostConfig.SecurityOpt.push('seccomp=unconfined'); }, /launch configuration/],
    [f => { container(f, 'workerd').NetworkSettings.Networks.original_control = { NetworkID: f.networks.control.Id }; }, /networks differ/],
    [f => { container(f, 'slot-1-a').NetworkSettings.Networks['original_fleet-1'].NetworkID = hex(5, 'f'); }, /networks differ/],
    [f => { container(f, 'slot-1-a').NetworkSettings.Networks['original_fleet-1'].IPAMConfig = { IPv4Address: '172.30.1.5' }; }, /networks differ/],
    [f => { f.networks.control.Driver = 'macvlan'; }, /network differs/],
    [f => { f.networks.control.Labels['com.docker.compose.project'] = 'other'; }, /network differs/],
    [f => { f.networks.control.Options = { 'com.docker.network.bridge.enable_ip_masquerade': 'false' }; }, /network differs/],
    [f => { f.networks['fleet-1'].EnableIPv6 = true; }, /network differs/],
    [f => { f.networks['fleet-1'].EnableIPv4 = false; }, /network differs/],
    [f => { container(f, 'controller').HostConfig.Sysctls = { 'net.ipv4.ip_forward': '1' }; }, /privileges or namespaces/],
    [f => { container(f, 'controller').HostConfig.CgroupnsMode = 'host'; }, /privileges or namespaces/],
    [f => { container(f, 'workerd').HostConfig.RestartPolicy.Name = 'always'; }, /restart policy/],
    [f => { container(f, 'workerd').HostConfig.PortBindings['8080/tcp'][0].HostIp = '0.0.0.0'; }, /published ports/],
    [f => { container(f, 'controller').HostConfig.PortBindings = { '8082/tcp': [{ HostIp: '127.0.0.1', HostPort: '8788' }] }; }, /published ports/],
    [f => { container(f, 'minio').HostConfig.PublishAllPorts = true; }, /published ports/],
  ];
  for (const [alter, pattern] of cases) { const f = fixture(); alter(f); await refused(f, pattern); }
});

test('declared network addressing must match the inspected subnets', async () => {
  const plan = { control: '10.253.180.0/24', 'fleet-1': '10.253.181.0/24', 'fleet-2': '10.253.182.0/24' };
  let f = fixture(plan);
  assert.deepEqual(f.config.networks.control.ipam, { config: [{ subnet: '10.253.180.0/24' }] });
  await inspect(f);
  f = fixture(plan); f.networks['fleet-1'].IPAM.Config[0].Subnet = '10.9.0.0/24'; await refused(f, /addressing differs/);
});

test('Docker failures and drifted secrets stay private', async () => {
  const f = fixture();
  await refused(f, /could not be verified|query failed/, async () => { throw new Error('daemon said private-password'); });
  container(f, 'bucket-init').Config.Env = container(f, 'bucket-init').Config.Env.map(e => e.startsWith('AWS_SECRET_ACCESS_KEY=') ? 'AWS_SECRET_ACCESS_KEY=private-other' : e);
  await refused(f, /launch configuration/);
});

test('network address-family fields that match the sealed topology are accepted', async () => {
  const f = fixture();
  for (const network of Object.values(f.networks)) Object.assign(network, { Options: {}, EnableIPv6: false, EnableIPv4: true });
  await inspect(f);
});

test('refuses container state without a parseable start time or a nonnegative integer exit code', async () => {
  for (const alter of [s => { delete s.StartedAt; }, s => { s.StartedAt = ''; }, s => { s.StartedAt = 'yesterday'; }, s => { s.StartedAt = 0; },
    s => { delete s.ExitCode; }, s => { s.ExitCode = -1; }, s => { s.ExitCode = 1.5; }, s => { s.ExitCode = '0'; }, s => { s.Paused = 'false'; }]) {
    const f = fixture(); alter(container(f, 'controller').State); await refused(f, /container state is unreadable/);
  }
});
