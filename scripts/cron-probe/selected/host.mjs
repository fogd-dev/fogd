import { captureFailureLogs } from './failure-logs.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, chmod, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFamily, verifyRuntimeFamily } from '../../../packages/cli/src/runtime/catalog.mjs';
import { docker, json, projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';
import { composeResolved } from '../../../packages/cli/src/recovery/bundle.mjs';
import { readPolicyVolume } from '../../../packages/cli/src/runtime/policy-volume.mjs';
import { runtimePolicyIdentity } from '../../../packages/platform/src/runtime-policy.mjs';
import { privateNetworks, loopbackPort } from './resources.mjs';
import { commandRunner, commandJson } from './commands.mjs';
import { expectRefusal } from './evidence.mjs';
import { stopRetainedContainers } from './retained-shutdown.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const enrollmentMethods = {
  candidate: { intent: 'enrolled', run: enrollCandidate, start: host => ['up', '--installation', host.project] },
  public: { intent: 'new', run: enrollPublic, start: host => ['up', '--shared', '--runtime', host.entry.id, '--network-plan', join(host.output, 'network-plan.json')] },
};

export async function selectedHost(directory, enrollment = 'candidate', programRoot = repo, { runtime = 'celld-cron-v2-linux-arm64', retainResources = false, sdkImage } = {}) {
  const cli = join(programRoot, 'packages/cli/bin/fogd.js');
  const method = enrollmentMethods[enrollment]; if (!method) throw new Error('Unknown qualification enrollment method');
  if (enrollment === 'candidate' && resolve(programRoot) !== resolve(repo)) throw new Error('Alternate operator programs require public enrollment; candidate qualification uses this checkout');
  const entry = runtimeFamily(runtime, method.intent); await verifyRuntimeFamily(entry);
  const output = resolve(directory); await mkdir(output, { mode: 0o700 });
  await mkdir(join(output, 'host'), { mode: 0o700 });
  const project = `fogd-selected-activation-${randomBytes(8).toString('hex')}`, adminPort = await loopbackPort(), gatewayPort = await loopbackPort();
  assert.notEqual(adminPort, gatewayPort);
  const env = selectedEnvironment(output, project, adminPort, gatewayPort, programRoot), run = commandRunner(output, env);
  await writeFile(env.FOGD_ENV_FILE, `FOGD_BUCKET_USER=${env.FOGD_BUCKET_USER}\nFOGD_BUCKET_PASSWORD=${env.FOGD_BUCKET_PASSWORD}\n`, { mode: 0o600, flag: 'wx' });
  const networks = await privateNetworks();
  await writeFile(join(output, 'inputs.json'), JSON.stringify({ project, family: entry.id, image: entry.image, adminPort, gatewayPort, networks, enrollment, retainResources }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const host = { output, project, entry, env, run, adminPort, gatewayPort, retainResources, sdkImage, enrollment: { method: enrollment },
    command: (args, options) => run(process.execPath, [cli, ...args], options),
    json: async (args, options) => commandJson(await run(process.execPath, [cli, ...args], options)),
  };
  try {
    await method.run(host, networks);
    host.config = composeResolved(JSON.parse(await readFile(join(env.FOGD_HOME, '.fogd/installations', project, 'compose.json'))));
    host.policy = await readPolicyVolume(entry.image, host.config.volumes['runtime-policy'].name, host.config.services.controller.environment);
    assert.deepEqual(host.policy.networks, networks);
    host.enrollment.networks = await json(['network', 'inspect', ...Object.values(host.config.networks).map(network => network.name)]);
    for (const [name, network] of Object.entries(host.config.networks)) {
      const actual = host.enrollment.networks.find(value => value.Name === network.name); assert.ok(actual);
      assert.deepEqual(actual.IPAM.Config.map(value => value.Subnet), [networks[name]]);
    }
    await createTLS(host);
    await host.command(method.start(host));
    await writeFile(join(output, 'identity.json'), JSON.stringify({ family: entry.id, identitySha256: runtimePolicyIdentity(host.policy) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return host;
  } catch (error) { await captureFailureLogs(host); await cleanupSelectedHost(host); throw error; }
}

async function enrollCandidate(host, networks) {
  const code = `import{prepareEnvironment}from ${JSON.stringify(new URL('../../../packages/cli/src/bootstrap.mjs', import.meta.url).href)};import{resolvedCompose}from ${JSON.stringify(new URL('../../../packages/cli/src/compose/config.mjs', import.meta.url).href)};import{selectedInstallation}from ${JSON.stringify(new URL('../../../packages/cli/src/runtime/installation.mjs', import.meta.url).href)};const env=await prepareEnvironment(true);await selectedInstallation(await resolvedCompose(env),${JSON.stringify({ runtime: host.entry.id, candidateEnrollment: true, networks })});`;
  await host.run(process.execPath, ['--input-type=module', '-e', code]);
}

async function enrollPublic(host, networks) {
  assert.equal(host.entry.admission, 'qualified');
  const file = join(host.output, 'network-plan.json');
  await writeFile(file, JSON.stringify(networks, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  host.enrollment.tlsRefusal = await expectRefusal(host, ['up', '--shared', '--runtime', host.entry.id, '--network-plan', file], /Installed TLS keypair could not be validated/);
  const containers = await projectContainers(host.project); assert.equal(containers.length, 8);
  host.enrollment.initialServices = containers.map(container => {
    assert.equal(container.State.Running, false); assert.equal(container.State.Restarting, false); assert.equal(container.State.Paused, false); assert.equal(container.RestartCount, 0);
    assert.ok(container.State.StartedAt.startsWith('0001-'));
    const service = container.Config.Labels['com.docker.compose.service'], expected = service === 'minio' ? host.entry.storageImage : host.entry.image;
    assert.equal(container.Image, expected); assert.equal(container.Config.Image, expected);
    return { service, image: container.Image, startedAt: container.State.StartedAt };
  });
}

function selectedEnvironment(output, project, adminPort, gatewayPort, programRoot) {
  const env = { ...process.env, FOGD_HOME: join(output, 'host'), FOGD_ENV_FILE: join(output, 'operator.env'), COMPOSE_PROJECT_NAME: project,
    FOGD_PROFILE: 'shared', FOGD_TLS: '1', FOGD_DEPLOY_TOKEN: '', FOGD_BIND_ADDRESS: '127.0.0.1', FOGD_ADMIN_PORT: String(adminPort),
    FOGD_HTTP_PORT: String(gatewayPort), FOGD_BASE_DOMAIN: 'localhost', FOGD_QUEUE_APPS: '1', FOGD_SERVER: `https://localhost:${adminPort}`,
    NODE_EXTRA_CA_CERTS: join(output, 'certificate.pem') };
  for (const name of ['FOGD_COMPOSE_FILE', 'FOGD_CELLD_IMAGE', 'FOGD_RUNTIME_IMAGE', 'FOGD_BUCKET_ENDPOINT', 'FOGD_BUCKET_REGION',
    'FOGD_CELLD_CPUS', 'FOGD_CELLD_MEMORY', 'FOGD_CELLD_HEAP_MB', 'FOGD_RESTART_DELAY_SECONDS', 'FOGD_ADMIN_PASSWORD', 'FOGD_GATEWAY_TOKEN', 'FOGD_SLOT_1_A_ID', 'FOGD_SLOT_1_B_ID', 'FOGD_SLOT_2_A_ID', 'FOGD_SLOT_2_B_ID']) delete env[name];
  env.FOGD_BUCKET_USER = `fogd-probe-${randomBytes(8).toString('hex')}`;
  env.FOGD_BUCKET_PASSWORD = randomBytes(32).toString('hex');
  env.FOGD_COMPOSE_FILE = join(programRoot, 'compose.yaml');
  return env;
}
async function createTLS(host) {
  const cert = join(host.output, 'certificate.pem'), key = join(host.output, 'private-key.pem');
  await host.run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,DNS:baseline.localhost,DNS:peer.localhost,DNS:refresh.localhost,DNS:imports.localhost,DNS:replacement.localhost,DNS:scheduled-next.localhost,IP:127.0.0.1']);
  await chmod(key, 0o600); await host.command(['tls', 'import', cert, key, '--installation', host.project]);
}
export async function cleanupSelectedHost(host) {
  // Only this newly generated qualification project is in scope. Data stays.
  const errors = [];
  try {
    const observers = (await docker(['ps', '-aq', '--filter', `label=fogd.qualifier.project=${host.project}`])).trim().split('\n').filter(Boolean);
    if (observers.length) await docker([...(host.retainResources ? ['stop'] : ['rm', '-f']), ...observers]);
  } catch (error) { errors.push(error); }
  if (host.retainResources) {
    try { await stopRetainedContainers(host.project, await projectContainers(host.project)); }
    catch (error) { errors.push(error); }
  }
  const resources = host.retainResources ? [] : [['ps', ['rm', '-f']], ['network', ['network', 'rm']]];
  for (const [kind, remove] of resources) {
    try {
      const args = kind === 'ps' ? ['ps', '-aq'] : ['network', 'ls', '-q'];
      const ids = (await docker([...args, '--filter', `label=com.docker.compose.project=${host.project}`])).trim().split('\n').filter(Boolean);
      if (ids.length) await docker([...remove, ...ids]);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Owned qualification cleanup failed; all volumes were retained');
}
