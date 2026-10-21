import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { privateCompose } from '../private-compose.mjs';
import { buildSealedRuntime } from './build.mjs';
import { artifactDigest } from '../../../packages/runtime/src/artifact.mjs';
import { stageFaultRefresh } from '../faults/build.mjs';
import { prepareActivation } from '../activation/artifacts.mjs';
import { retirementPolicy } from '../retirement/policy.mjs';
import { prepareRetirement } from '../retirement/artifacts.mjs';
import { prepareFailures } from '../faults/artifacts.mjs';
import { prepareReplacement } from '../replacement/artifacts.mjs';
import { composeLiteral, writeJson } from '../../../packages/cli/src/recovery/bundle.mjs';
import { cronRestoreConfig } from '../../../packages/cli/src/runtime/cron-preboot.mjs';
import { verifyCronRuntimeImage, verifyCronStorageImage } from '../../../packages/cli/src/runtime/cron-image.mjs';

const kinds = {
  recovery: { prepare: prepareRecovery, ports: [8950, 8951], networks: [235, 236, 237] },
  activation: { prepare: prepareActivation, ports: [8952, 8953], networks: [238, 239, 240] },
  replacement: { prepare: prepareReplacement, ports: [8954, 8955], networks: [241, 242, 243] },
  retirement: { prepare: output => prepareRetirement(output, 'full'), retirementMode: 'full', ports: [8958, 8959], networks: [247, 248, 249] },
  'retirement-dual': { prepare: output => prepareRetirement(output, 'dual'), retirementMode: 'dual', ports: [8960, 8961], networks: [250, 251, 252] },
  failures: { prepare: prepareFailures, ports: [8956, 8957], networks: [244, 245, 246] },
};
export async function sealedFixture(directory, { kind = 'recovery' } = {}) {
  assert.ok(Object.hasOwn(kinds, kind));
  const selectedKind = kinds[kind], [publicPort, adminPort] = selectedKind.ports;
  const output = resolve(directory); await mkdir(output, { mode: 0o700 });
  const receipt = JSON.parse(await readFile('docs/evidence/m11c-runtime-binding.json', 'utf8'));
  const checked = JSON.parse(await readFile('docs/evidence/m11c-runtime-preboot.json', 'utf8'));
  const project = `fogd-m11c-cron-${kind}-${randomBytes(3).toString('hex')}`;
  const networks = Object.fromEntries(['control', 'fleet-1', 'fleet-2'].map((name, index) => [name, `10.252.${selectedKind.networks[index]}.0/24`]));
  const { config, env } = await privateCompose({ project, runtimeImage: receipt.images.observer.id, storageImage: receipt.images.minio.id, networks });
  const identity = { schema: 2, binarySha256: receipt.nativeBuild.binarySha256, bucket: config.services.controller.environment.FOGD_BUCKET,
    storage: { endpoint: config.services.controller.environment.S3_ENDPOINT, region: config.services.controller.environment.AWS_REGION },
    fleets: JSON.parse(config.services.controller.environment.FOGD_SLOTS).map(fleet => ({ ...fleet,
      nodes: fleet.nodes.map(host => ({ host, id: config.services[host].environment.CELLD_NODE })),
    })) };
  const prepared = await selectedKind.prepare(output, identity);
  assert.ok(Object.keys(prepared.policy).every(key => ['expectedArtifactSha256', 'interruption', 'releases', 'retirementArtifacts'].includes(key)), 'Fixture policy cannot override runtime identity');
  if (selectedKind.retirementMode) prepared.policy.retirement = retirementPolicy(identity.fleets, prepared.ids, selectedKind.retirementMode);
  const { runner, artifact } = prepared;
  const built = await buildSealedRuntime(output, project, receipt, { ...identity, ...prepared.policy }, kind);
  for (const [name, service] of Object.entries(config.services)) if (name !== 'minio') service.image = built.image;
  const controllerArgs = ['/app/qualification/controller.mjs'];
  config.services.controller.command = ['node', ...controllerArgs];
  config.services.controller.environment.FOGD_QUEUE_APPS = '1';
  // The source and every restored target use explicit loopback ports.
  config.services.controller.ports = [{ target: 8082, published: String(adminPort), host_ip: '127.0.0.1', protocol: 'tcp' }];
  config.services.workerd.ports = [{ target: 8080, published: String(publicPort), host_ip: '127.0.0.1', protocol: 'tcp' }];
  const profile = { ...identity, image: built.image, storageImage: receipt.images.minio.id,
    supervisorSha256: checked.profile.supervisorSha256, controllerArgs, networks };
  const sealed = cronRestoreConfig({ requirements: ['fogd-cron-activation-v1'], apps: {}, deployments: {} }, config, profile);
  await verifyCronStorageImage(profile.storageImage); await verifyCronRuntimeImage(profile);
  await writeJson(join(output, 'compose.json'), composeLiteral(sealed));
  const selected = { FOGD_COMPOSE_FILE: join(output, 'compose.json'), COMPOSE_PROJECT_NAME: project, FOGD_SERVER: `http://127.0.0.1:${adminPort}`,
    FOGD_URL: `http://127.0.0.1:${publicPort}`, FOGD_TLS: '0', FOGD_PROFILE: 'local', FOGD_HTTP_PORT: String(publicPort), FOGD_ADMIN_USER: 'admin',
    FOGD_ADMIN_PASSWORD: env.FOGD_ADMIN_PASSWORD, FOGD_DEPLOY_TOKEN: env.FOGD_DEPLOY_TOKEN, FOGD_GATEWAY_TOKEN: env.FOGD_GATEWAY_TOKEN, FOGD_BASE_DOMAIN: 'localhost' };
  await writeJson(join(output, 'environment.json'), selected);
  assert.equal(identity.fleets.length, 2);
  return { output, config: sealed, selected, profile, built, runner, artifact, prepared };
}

async function prepareRecovery(output) {
  const runner = join(output, 'runner'); await mkdir(runner);
  const app = await stageFaultRefresh(join(output, 'build'));
  await writeFile(join(app.output, 'wrangler.json'), JSON.stringify(app.config));
  await cp(app.output, join(runner, 'artifact'), { recursive: true });
  const artifact = await artifactDigest(join(runner, 'artifact'));
  return { runner, artifact, policy: { expectedArtifactSha256: artifact } };
}
