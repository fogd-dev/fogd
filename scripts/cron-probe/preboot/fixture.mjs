import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { restoredConfig, composeLiteral } from '../../../packages/cli/src/recovery/bundle.mjs';
import { cronRestoreConfig } from '../../../packages/cli/src/runtime/cron-preboot.mjs';

export async function prebootFixture(directory) {
  const output = resolve(directory), project = `fogd-m11c-preboot-${randomUUID().slice(0, 8)}`;
  await mkdir(output, { mode: 0o700 });
  const inputs = await prebootInputs();
  await writeFile(join(output, 'source-pins.json'), JSON.stringify(inputs, null, 2), { mode: 0o600 });
  const receipt = JSON.parse(await readFile('docs/evidence/m11c-runtime-binding.json', 'utf8'));
  const image = receipt.images.observer.id;
  const env = Object.fromEntries(['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { COMPOSE_PROJECT_NAME: project, FOGD_RUNTIME_IMAGE: image, FOGD_BUCKET_USER: 'preboot-probe',
    FOGD_BUCKET_PASSWORD: randomUUID(), FOGD_ADMIN_PASSWORD: randomUUID(), FOGD_GATEWAY_TOKEN: randomUUID(), FOGD_DEPLOY_TOKEN: randomUUID() });
  const source = JSON.parse(await execute('docker', ['compose', '--env-file', '/dev/null', '-f', 'compose.yaml', 'config', '--format', 'json'], { env }));
  const images = Object.fromEntries(Object.keys(source.services).map(name => [name, name === 'minio' ? receipt.images.minio.id : image]));
  const config = restoredConfig(source, project, images);
  for (const service of Object.values(config.services)) delete service.ports;
  for (const [name, service] of Object.entries(config.services)) if (name.startsWith('slot-')) Object.assign(service.environment, {
    CELLD_CLOUD: '0', CELLD_RUNTIME_IDENTITY_LISTEN: '0.0.0.0:8082',
  });
  const networks = { control: '10.252.232.0/24', 'fleet-1': '10.252.233.0/24', 'fleet-2': '10.252.234.0/24' };
  for (const [name, subnet] of Object.entries(networks)) config.networks[name].ipam = { config: [{ subnet }] };
  const profile = { networks, schema: 2, image, storageImage: receipt.images.minio.id, binarySha256: receipt.nativeBuild.binarySha256,
    supervisorSha256: createHash('sha256').update(await readFile('docker/celld-supervisor.sh')).digest('hex'),
    bucket: env.FOGD_BUCKET || 'fogd', storage: { endpoint: 'http://minio:9000', region: 'us-east-1' },
    controllerArgs: ['packages/platform/src/main.mjs'], fleets: JSON.parse(config.services.controller.environment.FOGD_SLOTS).map(fleet => ({ ...fleet,
      nodes: fleet.nodes.map(host => ({ host, id: config.services[host].environment.CELLD_NODE })),
    })) };
  const sealed = cronRestoreConfig({ requirements: ['fogd-cron-activation-v1'], apps: {}, deployments: {} }, config, profile);
  const file = join(output, 'compose.json');
  await writeFile(file, JSON.stringify(composeLiteral(sealed)), { mode: 0o600 });
  const compose = args => execute('docker', ['compose', '--env-file', '/dev/null', '-f', file, '-p', project, ...args]);
  const save = (name, value) => writeFile(join(output, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { output, project, profile, config: sealed, compose, save, inputs };
}

export async function prebootMutants(probe) {
  const directory = join(probe.output, 'images'); await mkdir(directory);
  const base = `fogd-preboot:${probe.project}-base`;
  await execute('docker', ['tag', probe.profile.image, base]);
  assert.equal((await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', base])).trim(), probe.profile.image);
  const results = [];
  for (const [name, instruction] of [
    ['wrong-native', 'RUN cp /bin/true /usr/local/bin/celld'],
    ['symlink-native', 'RUN mv /usr/local/bin/celld /usr/local/bin/celld.real && ln -s celld.real /usr/local/bin/celld'],
    ['shadow-native', 'RUN cp /bin/true /app/packages/runtime/node_modules/.bin/celld'],
    ['declared-volume', 'VOLUME /app'], ['loader-env', 'ENV OPENSSL_CONF=/tmp/preboot-provider.cnf'],
    ['active-healthcheck', 'HEALTHCHECK CMD ["celld", "--help"]'],
  ]) {
    const file = join(directory, `${name}.Dockerfile`);
    await writeFile(file, `FROM ${base}\n${instruction}\n`, { mode: 0o600 });
    const tag = `fogd-preboot:${probe.project}-${name}`;
    await execute('docker', ['build', '--quiet', '-f', file, '-t', tag, directory]);
    const id = (await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', tag])).trim(); assert.match(id, /^sha256:[a-f0-9]{64}$/);
    assert.equal((await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', base])).trim(), probe.profile.image);
    results.push({ name, tag, id });
  }
  return results;
}

export async function prebootInputs() {
  const files = ['compose.yaml', 'docker/celld-supervisor.sh', 'package.json', 'pnpm-lock.yaml',
    'packages/cli/package.json', 'packages/platform/package.json', 'packages/runtime/package.json',
    'docs/evidence/m11c-runtime-binding.json', 'scripts/cron-runtime-preboot.mjs', 'scripts/cron-probe/preboot/fixture.mjs'];
  for (const directory of ['packages/cli/src', 'packages/platform/src', 'packages/runtime/src']) await collect(directory, files);
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
}
async function collect(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await collect(file, files);
    else if (entry.isFile()) files.push(file);
  }
}
