// This fake is an out-of-process Docker boundary, never a production entry point.
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2), path = process.env.FOGD_OBSERVE_TEST_DATA;
const data = JSON.parse(readFileSync(path)), { config, policy, entry } = data;
let input = ''; if (args.includes('-i')) for await (const part of process.stdin) input += part;
appendFileSync(process.env.FOGD_TEST_LOG, JSON.stringify({ args, input }) + '\n');
const output = value => console.log(JSON.stringify(value));
if (args[0] === 'info') output({ OSType: 'linux', Architecture: 'arm64' });
else if (args[0] === 'image' && args[1] === 'inspect') output([{ Id: args.at(-1), Os: 'linux', Architecture: 'arm64', Config: { WorkingDir: '/app', Env: ['PATH=/usr/local/bin:/usr/bin:/bin'], Cmd: ['node', 'packages/runtime/src/serve.mjs'], Entrypoint: null } }]);
else if (args[0] === 'volume' && args[1] === 'ls') console.log(Object.entries(config.volumes).filter(([role]) => role !== process.env.FOGD_OBSERVE_MISSING_VOLUME).map(([, value]) => value.name).join('\n'));
else if (args[0] === 'volume' && args[1] === 'inspect') output(args.slice(2).map(Name => ({ Name, Driver: 'local', Options: {}, Labels: { 'com.docker.compose.project': process.env.FOGD_OBSERVE_FOREIGN_POLICY || config.name, 'com.docker.compose.volume': Object.keys(config.volumes).find(role => config.volumes[role].name === Name) } })));
else if (args[0] === 'network' && args[1] === 'inspect') {
  const [role, network] = Object.entries(config.networks).find(([, value]) => value.name === args.at(-1));
  output([{ Id: 'network-' + role, Name: network.name, Labels: { 'com.docker.compose.project': process.env.FOGD_OBSERVE_FOREIGN_NETWORK || config.name, 'com.docker.compose.network': role } }]);
} else if (args[0] === 'ps') {
  if (args.some(value => value.startsWith('label=fogd.observer.id='))) {
    if (process.env.FOGD_OBSERVE_CLEANUP_FAIL) process.exit(1);
    if (data.helperCreated) console.log('a'.repeat(64));
  } else console.log('controller\nslot-1-a\nslot-1-b\nslot-2-a\nslot-2-b\nworkerd');
} else if (args[0] === 'inspect') output(args.slice(1).map(role => {
  const service = config.services[role], gateway = role === 'workerd';
  const result = { Id: role + '-container', Image: role === 'slot-1-b' && process.env.FOGD_OBSERVE_WRONG_IMAGE ? 'sha256:'+'f'.repeat(64) : entry.image,
    Config: { Image: entry.image, Labels: { 'com.docker.compose.service': role },
      Env: ['PATH=/usr/local/bin:/usr/bin:/bin', ...Object.entries(service.environment).map(([k,v]) => `${k}=${v}`)],
      Cmd: service.command || ['node', 'packages/runtime/src/serve.mjs'], Entrypoint: service.entrypoint || null },
    HostConfig: { ReadonlyRootfs: service.read_only, CapDrop: service.cap_drop, SecurityOpt: service.security_opt,
      Tmpfs: service.tmpfs ? { '/tmp': 'rw,noexec,nosuid,nodev' } : {} },
    Mounts: (service.volumes || []).map(m => ({ Type: 'volume', Name: config.volumes[m.source].name, Destination: m.target, RW: !m.read_only })),
    NetworkSettings: { Networks: Object.fromEntries(Object.keys(service.networks).map(name => [config.networks[name].name, { NetworkID: 'network-' + name, IPAddress: gateway ? '172.20.0.10' : '172.20.0.11' }])) },
    State: { StartedAt: '2026-10-23T00:00:00Z', Running: role !== 'controller' || !process.env.FOGD_OBSERVE_CONTROLLER_STOPPED, Paused: false, Restarting: false } };
  return gateway && data.gateway ? { ...result, ...data.gateway, Config: { ...result.Config, ...data.gateway.Config } } : result;
}));
else if (args[0] === 'rm') { data.helperCreated = false; writeFileSync(path, JSON.stringify(data)); }
else if (args[0] === 'run') {
  const code = args.at(-1);
  if (code.includes('Runtime program must not be a symlink')) output({ binarySha256: entry.binarySha256, supervisorSha256: entry.supervisorSha256 });
  else if (code.includes('programInventory')) output(entry.sourceFiles);
  else if (code.includes('readRuntimePolicy')) output(policy);
  else if (code.includes('/data/state.json')) {
    if (process.env.FOGD_OBSERVE_CORRUPT_STATE) console.log('private-invalid-state'); else output(data.state);
  } else if (args.some(value => value.startsWith('fogd.observer.id='))) {
    if (process.env.FOGD_OBSERVE_HELPER_FAIL) { data.helperCreated = true; writeFileSync(path, JSON.stringify(data)); process.exit(7); }
    if (process.env.FOGD_OBSERVE_STATE_CHANGE) { data.state.apps.sample.route = 'paused'; writeFileSync(path, JSON.stringify(data)); }
    if (code.includes('checkGateway')) { output({ httpStatus: 503, headersMs: 7, reason: null, body: 'private-worker-extra' }); process.exit(0); }
    output({ identity: process.env.FOGD_OBSERVE_UNVERIFIED ? 'unconfirmed' : 'verified', replicas: ['slot-1-a', 'slot-1-b'].map(node => ({ node, stateHTTPStatus: 200, healthHTTPStatus: 200, version: 'matches' })), secrets: 'private-worker-extra' });
  } else process.exit(98);
} else process.exit(99);
