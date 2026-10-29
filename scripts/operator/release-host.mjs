import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { commandRunner, commandJson } from '../cron-probe/selected/commands.mjs';
import { privateNetworks, loopbackPort } from '../cron-probe/selected/resources.mjs';
import { expectRefusal } from '../cron-probe/selected/evidence.mjs';
import { composeResolved } from '../../packages/cli/src/recovery/bundle.mjs';
import { readPolicyVolume } from '../../packages/cli/src/runtime/policy-volume.mjs';

export function receivedCommands(program, host) {
  host.command = (args, options) => host.run(process.execPath, [host.client && ['deploy', 'status', 'capabilities'].includes(args[0]) ? host.client : join(program, 'packages/cli/bin/fogd.js'), ...args], { cwd: program, ...options });
  host.json = async (args, options) => commandJson(await host.command(args, options));
  return host;
}
export async function loadReceivedHost(host) {
  host.config = composeResolved(JSON.parse(await readFile(join(host.env.FOGD_HOME, '.fogd/installations', host.project, 'compose.json'))));
  host.policy = await readPolicyVolume(host.entry.image, host.config.volumes['runtime-policy'].name, host.config.services.controller.environment);
  assert.equal(host.policy.admission, 'qualified');
  return host;
}
export async function freshReceivedHost(program, output, hosts, { runtime = 'celld-durable-v5-linux-arm64' } = {}) {
  await mkdir(output, { mode: 0o700 }); await mkdir(join(output, 'home'), { mode: 0o700 });
  const { runtimeFamily } = await import(join(program, 'packages/cli/src/runtime/catalog.mjs'));
  const project = `fogd-release-${randomBytes(8).toString('hex')}`, adminPort = await loopbackPort(), gatewayPort = await loopbackPort(); assert.notEqual(adminPort, gatewayPort);
  const env = { ...process.env }; for (const name of Object.keys(env)) if (name.startsWith('FOGD_')) delete env[name];
  Object.assign(env, { FOGD_HOME: join(output, 'home'), FOGD_ENV_FILE: join(output, 'operator.env'), FOGD_COMPOSE_FILE: join(program, 'compose.yaml'), COMPOSE_PROJECT_NAME: project,
    FOGD_PROFILE: 'shared', FOGD_TLS: '1', FOGD_DEPLOY_TOKEN: '', FOGD_BIND_ADDRESS: '127.0.0.1', FOGD_ADMIN_PORT: String(adminPort), FOGD_HTTP_PORT: String(gatewayPort),
    FOGD_BASE_DOMAIN: 'localhost', FOGD_SERVER: `https://localhost:${adminPort}`, NODE_EXTRA_CA_CERTS: join(output, 'certificate.pem'),
    FOGD_BUCKET_USER: `fogd-release-${randomBytes(8).toString('hex')}`, FOGD_BUCKET_PASSWORD: randomBytes(32).toString('hex') });
  await writeFile(env.FOGD_ENV_FILE, `FOGD_BUCKET_USER=${env.FOGD_BUCKET_USER}\nFOGD_BUCKET_PASSWORD=${env.FOGD_BUCKET_PASSWORD}\n`, { flag: 'wx', mode: 0o600 });
  const host = receivedCommands(program, { program, output, project, env, run: commandRunner(output, env), entry: runtimeFamily(runtime), adminPort, gatewayPort, retainResources: true }); hosts.push(host);
  await writeFile(join(output, 'inputs.json'), JSON.stringify({ project, family: host.entry.id, image: host.entry.image, program, adminPort, gatewayPort, retainResources: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await host.run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(output, 'private-key.pem'), '-out', env.NODE_EXTRA_CA_CERTS, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,DNS:baseline.localhost,DNS:peer.localhost,IP:127.0.0.1']);
  await chmod(join(output, 'private-key.pem'), 0o600);
  await writeFile(join(output, 'network-plan.json'), JSON.stringify(await privateNetworks()) + '\n', { flag: 'wx', mode: 0o600 });
  host.tlsRefusal = await expectRefusal(host, ['up', '--shared', '--runtime', host.entry.id, '--network-plan', join(output, 'network-plan.json')], /Installed TLS keypair could not be validated/);
  await loadReceivedHost(host);
  const ids = (await host.run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`])).trim().split(/\s+/);
  const initial = JSON.parse(await host.run('docker', ['inspect', ...ids])); assert.equal(initial.length, 8); assert.ok(initial.every(c => !c.State.Running && c.State.StartedAt.startsWith('0001-')));
  host.initialServices = initial.map(c => ({ service: c.Config.Labels['com.docker.compose.service'], image: c.Image, startedAt: c.State.StartedAt }));
  await host.command(['tls', 'import', env.NODE_EXTRA_CA_CERTS, join(output, 'private-key.pem'), '--installation', project]);
  await host.command(['up', '--installation', project]);
  return host;
}
