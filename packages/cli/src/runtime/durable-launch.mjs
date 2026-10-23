import { isDeepStrictEqual } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { isIP } from 'node:net';
import { runtimePolicyIdentity, validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { transportPolicy } from '@fogd/runtime/transport';
import { docker } from '../recovery/docker.mjs';
import { assertSharedStorageConfiguration } from '../shared-storage.mjs';
import { checkInstalledTLS } from '../tls.mjs';
import { authorizeInstalledPolicy, verifyRuntimeFamily } from './catalog.mjs';
import { durableRuntimeConfig } from './durable-config.mjs';
import { inspectDurableInstallation } from './durable-inventory.mjs';
import { readDurableStores } from './durable-stores.mjs';
import { acquireLaunchFence } from './launch-fence.mjs';
import { installationDirectory, assertRuntimeReady } from './installation-state.mjs';
import { assertRecoverySourceStopped } from './recovery-source.mjs';
import { requestRoutingPreflight } from './route-preflight.mjs';
import { readPolicyVolume } from './policy-volume.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const refused = () => Object.assign(new Error('Durable startup is unconfirmed; retain its resources and inspect the launch fence and ingress state'), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
const active = state => state?.running === true && state.restarting === false && state.paused === false && state.status === 'running';
const stopped = state => state?.running === false && state.restarting === false && state.paused === false && ['created', 'exited'].includes(state.status);

function checkedSnapshot(snapshot, config, previous) {
  if (!hash(snapshot?.identity) || !snapshot.services || !isDeepStrictEqual(Object.keys(snapshot.services).sort(), Object.keys(config.services).sort()) ||
    Object.values(snapshot.services).some(state => !hash(state?.id)) || previous && snapshot.identity !== previous.identity) throw refused();
  if (previous && !isDeepStrictEqual(Object.fromEntries(Object.entries(snapshot.services).map(([name, value]) => [name, value.id])),
    Object.fromEntries(Object.entries(previous.services).map(([name, value]) => [name, value.id])))) throw refused();
  return snapshot;
}
function requireStopped(snapshot) {
  if (!Object.values(snapshot.services).every(stopped)) throw refused();
}
function requireReady(snapshot, ingress) {
  for (const [name, state] of Object.entries(snapshot.services)) {
    if (name === 'bucket-init') { if (!stopped(state) || state.status !== 'exited' || state.exitCode !== 0) throw refused(); }
    else if (name === 'workerd') { if (!(ingress ? active(state) : stopped(state))) throw refused(); }
    else if (!active(state)) throw refused();
  }
}
function sameProcesses(before, after) {
  if (Object.entries(before.services).some(([name, state]) => name !== 'workerd' && state.startedAt !== after.services[name].startedAt)) throw refused();
}
function adminPort(config) {
  const ports = (config.services.controller.ports || []).filter(port => port.target === 8082 && (port.protocol || 'tcp') === 'tcp');
  if (ports.length !== 1) throw refused();
  const port = ports[0];
  if (!/^[1-9][0-9]{0,4}$/.test(String(port.published)) || Number(port.published) > 65535) throw refused();
  return port;
}
function defaultControlOrigin(port, tls) {
  const bind = port.host_ip || '127.0.0.1', host = ['0.0.0.0', '::'].includes(bind) ? '127.0.0.1' : bind;
  if (!isIP(host)) throw refused();
  const url = new URL('http://localhost'); url.protocol = tls ? 'https:' : 'http:';
  url.hostname = isIP(host) === 6 ? `[${host}]` : host; url.port = String(port.published); return url.origin;
}
function checkedControlOrigin(value, tls) {
  const url = new URL(value), forbidden = [url.username, url.password, url.search, url.hash].some(Boolean);
  if (forbidden || url.pathname !== '/' || url.protocol !== (tls ? 'https:' : 'http:')) throw refused();
  if (!tls && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw refused();
  return url.origin;
}
function controlEnvironment(config, server) {
  const env = { ...config.services.controller.environment }, tls = env.FOGD_TLS === '1', port = adminPort(config);
  env.FOGD_SERVER = checkedControlOrigin(server || defaultControlOrigin(port, tls), tls); return env;
}
async function readyObservation(env, policy, observe, delay) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 90000);
  try {
    while (!controller.signal.aborted) {
      try {
        const report = await observe(env, policy, { signal: controller.signal });
        if (controller.signal.aborted) throw refused();
        return report;
      }
      catch { await delay(500, undefined, { signal: controller.signal }); }
    }
    throw refused();
  } finally { clearTimeout(timeout); controller.abort(); }
}

async function launchSelection(selected, io) {
  const config = selected.config, policy = validateRuntimePolicy(selected.policy, config.services.controller.environment);
  if (policy.schema !== 3 || !isDeepStrictEqual(durableRuntimeConfig(config, policy), config)) throw refused();
  if (!isDeepStrictEqual(await io.authorize(policy), selected.entry)) throw refused();
  const env = controlEnvironment(config, io.server), transport = transportPolicy(env);
  assertSharedStorageConfiguration(config);
  return { config, policy, env, transport, entry: selected.entry };
}
async function checkRetained(context, io) {
  const { config, policy, env, entry, transport } = context;
  await io.ready(config.name); await io.recovery(config.name); await io.verify(entry);
  if (transport.tls) await io.tls(env, config);
  const first = checkedSnapshot(await io.inspect(config, policy, { run: io.run }), config); requireStopped(first);
  await matchingPolicy(context, io);
  await io.readStores(config, policy);
  requireStopped(checkedSnapshot(await io.inspect(config, policy, { run: io.run }), config, first));
  return first;
}
async function matchingPolicy({ config, policy, env }, io) {
  if (!isDeepStrictEqual(await io.readPolicy(policy.image, config.volumes['runtime-policy'].name, env), policy)) throw refused();
}
async function activateRetained(context, first, fence, io) {
  const { config, policy, env } = context;
  await fence.record('starting');
  await io.run(['start', first.services.minio.id]);
  if (first.services['bucket-init'].status !== 'exited' || first.services['bucket-init'].exitCode !== 0) await io.run(['start', '--attach', first.services['bucket-init'].id]);
  const backend = Object.keys(config.services).filter(name => !['minio', 'bucket-init', 'controller', 'workerd'].includes(name)).sort();
  await io.run(['start', ...backend.map(name => first.services[name].id)]);
  await io.run(['start', first.services.controller.id]);
  const processes = checkedSnapshot(await io.inspect(config, policy, { run: io.run }), config, first);
  await fence.record('preflight');
  const report = await readyObservation(env, policy, io.observe, io.delay);
  const stores = await io.readStores(config, policy);
  if (!isDeepStrictEqual(report?.authority, stores.authority)) throw refused();
  await matchingPolicy(context, io);
  const before = checkedSnapshot(await io.inspect(config, policy, { run: io.run }), config, first);
  requireReady(before, false); sameProcesses(processes, before);
  await fence.record('ingress');
  await io.run(['start', first.services.workerd.id]);
  const after = checkedSnapshot(await io.inspect(config, policy, { run: io.run }), config, first);
  requireReady(after, true); sameProcesses(processes, after);
  await fence.record('complete');
  return { project: config.name, status: 'started', installation: runtimePolicyIdentity(policy), authoritySha256: stores.authority.sha256 };
}
async function failedLaunch(attempt, io) {
  // Never mutate resources after completion/release: a successor may own the
  // fence even if the final directory sync reported an uncertain release.
  if (attempt.started && !attempt.complete && attempt.gateway) {
    try { await io.run(['stop', '--time', '30', attempt.gateway]); } catch { /* Retain fence; ingress state is unconfirmed. */ }
  }
  if (attempt.fence && !attempt.started) { try { await attempt.fence.release(); } catch { /* An uncertain marker remains a refusal. */ } }
}

// Retained, already enrolled containers only. No compose create/up, image pull,
// policy installation or authority initialization is permitted by this operation.
export async function startDurableInstallation(selected, options = {}) {
  const io = { run: docker, inspect: inspectDurableInstallation, readStores: readDurableStores, observe: requestRoutingPreflight,
    authorize: authorizeInstalledPolicy, verify: verifyRuntimeFamily, acquire: acquireLaunchFence, delay: pause,
    ready: assertRuntimeReady, recovery: assertRecoverySourceStopped, tls: checkInstalledTLS, readPolicy: readPolicyVolume,
    server: process.env.FOGD_SERVER, ...options };
  const attempt = { fence: null, started: false, complete: false, gateway: null };
  try {
    const context = await launchSelection(selected, io), { config, policy } = context;
    attempt.fence = await io.acquire(io.directory ?? installationDirectory(config.name), { project: config.name, installation: runtimePolicyIdentity(policy) });
    const first = await checkRetained(context, io); attempt.gateway = first.services.workerd.id;
    attempt.started = true;
    const receipt = await activateRetained(context, first, attempt.fence, io); attempt.complete = true;
    await attempt.fence.release();
    return receipt;
  } catch {
    await failedLaunch(attempt, io);
    throw refused();
  }
}
