import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, chmod, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFamily, verifyRuntimeFamily } from '../../../packages/cli/src/runtime/catalog.mjs';
import { docker } from '../../../packages/cli/src/recovery/docker.mjs';
import { composeResolved } from '../../../packages/cli/src/recovery/bundle.mjs';
import { readPolicyVolume } from '../../../packages/cli/src/runtime/policy-volume.mjs';
import { runtimePolicyIdentity } from '../../../packages/platform/src/runtime-policy.mjs';
import { privateNetworks, loopbackPort } from './resources.mjs';
import { commandRunner, commandJson } from './commands.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url)), cli = join(repo, 'packages/cli/bin/fogd.js');

export async function selectedHost(directory) {
  const output = resolve(directory); await mkdir(output, { mode: 0o700 });
  await mkdir(join(output, 'host'), { mode: 0o700 });
  const entry = runtimeFamily('celld-cron-v2-linux-arm64', 'enrolled'); await verifyRuntimeFamily(entry);
  const project = `fogd-selected-activation-${randomBytes(8).toString('hex')}`, adminPort = await loopbackPort(), gatewayPort = await loopbackPort();
  assert.notEqual(adminPort, gatewayPort);
  const env = selectedEnvironment(output, project, adminPort, gatewayPort), run = commandRunner(output, env);
  const networks = await privateNetworks();
  await writeFile(join(output, 'inputs.json'), JSON.stringify({ project, family: entry.id, image: entry.image, adminPort, gatewayPort, networks }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  const code = `import{prepareEnvironment}from ${JSON.stringify(new URL('../../../packages/cli/src/bootstrap.mjs', import.meta.url).href)};import{resolvedCompose}from ${JSON.stringify(new URL('../../../packages/cli/src/compose/config.mjs', import.meta.url).href)};import{selectedInstallation}from ${JSON.stringify(new URL('../../../packages/cli/src/runtime/installation.mjs', import.meta.url).href)};const env=await prepareEnvironment(true);await selectedInstallation(await resolvedCompose(env),${JSON.stringify({ runtime: entry.id, candidateEnrollment: true, networks })});`;
  const host = { output, project, entry, env, run, adminPort, gatewayPort,
    command: (args, options) => run(process.execPath, [cli, ...args], options),
    json: async (args, options) => commandJson(await run(process.execPath, [cli, ...args], options)),
  };
  try {
    await run(process.execPath, ['--input-type=module', '-e', code]);
    host.config = composeResolved(JSON.parse(await readFile(join(env.FOGD_HOME, '.fogd/installations', project, 'compose.json'))));
    host.policy = await readPolicyVolume(entry.image, host.config.volumes['runtime-policy'].name, host.config.services.controller.environment);
    await createTLS(host);
    await host.command(['up', '--installation', project]);
    await writeFile(join(output, 'identity.json'), JSON.stringify({ family: entry.id, identitySha256: runtimePolicyIdentity(host.policy) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return host;
  } catch (error) { await cleanupSelectedHost(host); throw error; }
}

function selectedEnvironment(output, project, adminPort, gatewayPort) {
  const env = { ...process.env, FOGD_HOME: join(output, 'host'), FOGD_ENV_FILE: join(output, 'operator.env'), COMPOSE_PROJECT_NAME: project,
    FOGD_PROFILE: 'shared', FOGD_TLS: '1', FOGD_DEPLOY_TOKEN: '', FOGD_BIND_ADDRESS: '127.0.0.1', FOGD_ADMIN_PORT: String(adminPort),
    FOGD_HTTP_PORT: String(gatewayPort), FOGD_BASE_DOMAIN: 'localhost', FOGD_QUEUE_APPS: '1', FOGD_SERVER: `https://localhost:${adminPort}`,
    NODE_EXTRA_CA_CERTS: join(output, 'certificate.pem') };
  for (const name of ['FOGD_COMPOSE_FILE', 'FOGD_CELLD_IMAGE', 'FOGD_RUNTIME_IMAGE', 'FOGD_BUCKET_ENDPOINT', 'FOGD_BUCKET_REGION',
    'FOGD_ADMIN_PASSWORD', 'FOGD_GATEWAY_TOKEN', 'FOGD_SLOT_1_A_ID', 'FOGD_SLOT_1_B_ID', 'FOGD_SLOT_2_A_ID', 'FOGD_SLOT_2_B_ID']) delete env[name];
  env.FOGD_COMPOSE_FILE = join(repo, 'compose.yaml');
  return env;
}
async function createTLS(host) {
  const cert = join(host.output, 'certificate.pem'), key = join(host.output, 'private-key.pem');
  await host.run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,DNS:baseline.localhost,DNS:refresh.localhost,IP:127.0.0.1']);
  await chmod(key, 0o600); await host.command(['tls', 'import', cert, key]);
}
export async function cleanupSelectedHost(host) {
  // Only this newly generated qualification project is in scope. Data stays.
  const errors = [];
  try {
    const observers = (await docker(['ps', '-aq', '--filter', `label=fogd.qualifier.project=${host.project}`])).trim().split('\n').filter(Boolean);
    if (observers.length) await docker(['rm', '-f', ...observers]);
  } catch (error) { errors.push(error); }
  for (const [kind, remove] of [['ps', ['rm', '-f']], ['network', ['network', 'rm']]]) {
    try {
      const args = kind === 'ps' ? ['ps', '-aq'] : ['network', 'ls', '-q'];
      const ids = (await docker([...args, '--filter', `label=com.docker.compose.project=${host.project}`])).trim().split('\n').filter(Boolean);
      if (ids.length) await docker([...remove, ...ids]);
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Owned qualification cleanup failed; all volumes were retained');
}
