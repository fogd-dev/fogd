import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';

export async function fixture(outputArg, image, { observerImage = 'fogd-runtime:cron-retirement-candidate6' } = {}) {
  assert.ok(outputArg && image, 'Supply a new private output directory and checked native build image');
  const output = resolve(outputArg), project = `fogd-m11c-identity-${randomUUID().slice(0, 8)}`;
  await mkdir(output, { mode: 0o700 });
  const bucket = { S3_ENDPOINT: 'http://minio:9000', AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'identity-probe', AWS_SECRET_ACCESS_KEY: randomUUID(), FOGD_BUCKET: 'identity-probe' };
  const tags = { native: image, observer: observerImage, older: 'fogd-celld-cron-controls-build5:local', minio: 'fogd-minio:local' };
  const images = Object.fromEntries(await Promise.all(Object.entries(tags).map(async ([role, tag]) => {
    const id = (await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', tag])).trim();
    assert.match(id, /^sha256:[a-f0-9]{64}$/);
    return [role, { tag, id }];
  })));

  const native = (name, enabled = true, selected = images.native.id) => ({ image: selected, entrypoint: ['/out/celld'],
    command: ['--listen', '0.0.0.0:8080', '--internal-listen', '0.0.0.0:8081', '--advertise', `${name}:8081`],
    environment: { ...bucket, AWS_ENDPOINT_URL: bucket.S3_ENDPOINT, CELLD_BUCKET: `S3://identity-probe//slots///${['a', 'b'].includes(name) ? 'one' : name}/`,
      CELLD_NODE: name, CELLD_WATCH: '/var/lib/celld/state',
      ...(enabled ? { CELLD_RUNTIME_IDENTITY_LISTEN: '0.0.0.0:8082' } : {}) },
    volumes: [`node-${name}:/var/lib/celld`], depends_on: { init: { condition: 'service_completed_successfully' } },
    mem_limit: '512m', cpus: 1 });
  const services = {
    minio: { image: images.minio.id, environment: { MINIO_ROOT_USER: bucket.AWS_ACCESS_KEY_ID,
      MINIO_ROOT_PASSWORD: bucket.AWS_SECRET_ACCESS_KEY }, volumes: ['bucket:/data'], mem_limit: '768m', cpus: 2 },
    init: { image: images.observer.id, environment: bucket, command: ['node', 'packages/runtime/src/init-bucket.mjs'], depends_on: ['minio'] },
    observer: { image: images.observer.id, environment: bucket, command: ['node', '-e', 'setInterval(()=>{},1000)'] },
    a: native('a'), b: native('b'), disabled: native('disabled', false),
    older: native('older', true, images.older.id),
  };
  for (const [name, environment] of Object.entries({ invalid: { CELLD_RUNTIME_IDENTITY_LISTEN: 'bogus' },
    devstore: { CELLD_INTERNAL_DEV_STORE: '/tmp/dev.sqlite' } })) {
    const service = native(name);
    delete service.volumes;
    services[name] = { ...service, environment: { ...service.environment, ...environment } };
    if (name === 'devstore') {
      services[name].command = ['--listen', '127.0.0.1:8080', '--internal-listen', '127.0.0.1:8081'];
      services[name].environment.CELLD_BUCKET = 'celld-dev';
      delete services[name].environment.S3_ENDPOINT;
      delete services[name].environment.AWS_ENDPOINT_URL;
    }
  }
  const file = join(output, 'compose.json');
  await writeFile(file, JSON.stringify({ services, networks: { default: { ipam: { config: [{ subnet: process.env.FOGD_IDENTITY_PROBE_SUBNET || '10.252.225.0/24' }] } } }, volumes: Object.fromEntries(['bucket', 'node-a', 'node-b', 'node-disabled', 'node-older'].map(v => [v, {}])) }), { mode: 0o600 });
  const compose = args => execute('docker', ['compose', '-f', file, '-p', project, ...args]);
  const node = code => compose(['exec', '-T', 'observer', 'node', '--input-type=module', '-e', code]);
  const save = (name, value) => writeFile(join(output, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { output, project, compose, node, save, images };
}

export async function finishFixture(probe, failed) {
  const filter = `label=com.docker.compose.project=${probe.project}`;
  const inventory = async () => (await execute('docker', ['volume', 'ls', '-q', '--filter', filter])).trim().split('\n').filter(Boolean).sort();
  const before = await inventory();
  try { await probe.save('logs', { logs: await probe.compose(['logs', '--no-color']) }); }
  finally { await probe.compose(['down']); }
  const volumes = await inventory();
  assert.deepEqual(volumes, before, 'Cleanup must retain every volume, including after partial setup');
  if (!failed) assert.equal(volumes.length, 5);
  assert.equal((await execute('docker', ['ps', '-aq', '--filter', filter])).trim(), '');
  assert.equal((await execute('docker', ['network', 'ls', '-q', '--filter', filter])).trim(), '');
  await probe.save('cleanup', { stopped: true, retainedVolumes: volumes });
}
