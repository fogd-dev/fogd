import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { composeLiteral, writeJson, validateTopology } from '../../../packages/cli/src/recovery/bundle.mjs';
import { stageFaultRefresh } from '../faults/build.mjs';

// Explicit local lab template only. Never change an existing installation.
export async function prepareRecoveryFixture(template, directory, image, pinnedImage, profile = 'recovery') {
  assert.ok(['recovery', 'retirement'].includes(profile));
  assert.match(image, /^fogd-runtime:cron-(?:recovery|retirement)-candidate[0-9]+$/);
  assert.match(pinnedImage, /^sha256:[a-f0-9]{64}$/);
  await mkdir(directory, { mode: 0o700 });
  const config = JSON.parse(await readFile(template, 'utf8'));
  assert.match(config.name, /^fogd-m11c-/);
  config.name = `fogd-m11c-cron-${profile}-${randomBytes(3).toString('hex')}`;
  const password = randomBytes(24).toString('hex'), gateway = randomBytes(24).toString('hex'), deploy = randomBytes(24).toString('hex'), bucketPassword = randomBytes(24).toString('hex');
  for (const service of Object.values(config.services)) {
    delete service.build; delete service.ports;
    if (service.environment?.AWS_SECRET_ACCESS_KEY) service.environment.AWS_SECRET_ACCESS_KEY = bucketPassword;
    if (service.environment?.AWS_ACCESS_KEY_ID) service.environment.AWS_ACCESS_KEY_ID = 'fogd-recovery-lab';
  }
  for (const [name, service] of Object.entries(config.services)) if (name !== 'minio') service.image = pinnedImage;
  Object.assign(config.services.minio.environment, { MINIO_ROOT_USER: 'fogd-recovery-lab', MINIO_ROOT_PASSWORD: bucketPassword });
  const control = config.services.controller;
  assert.equal(JSON.parse(control.environment.FOGD_SLOTS).length, 2, 'This native qualification requires exactly two application fleets');
  Object.assign(control.environment, { FOGD_BASE_DOMAIN: 'localhost', FOGD_ADMIN_USER: 'admin', FOGD_ADMIN_PASSWORD: password, FOGD_GATEWAY_TOKEN: gateway, FOGD_DEPLOY_TOKEN: deploy, FOGD_QUEUE_APPS: '1', FOGD_TLS: '0', FOGD_PROFILE: 'local', FOGD_PUBLIC_BIND_ADDRESS: '127.0.0.1', COMPOSE_PROJECT_NAME: config.name });
  control.command = ['node', '/var/lib/fogd/qualification/controller.mjs'];
  control.ports = [{ target: 8082, published: '8920', host_ip: '127.0.0.1', protocol: 'tcp' }];
  config.services.workerd.ports = [{ target: 8080, published: '8919', host_ip: '127.0.0.1', protocol: 'tcp' }];
  Object.assign(config.services.workerd.environment, { FOGD_GATEWAY_TOKEN: gateway, FOGD_CONTROLLER: 'controller:8083', FOGD_TLS: '0', FOGD_PROFILE: 'local', FOGD_PUBLIC_BIND_ADDRESS: '127.0.0.1' });
  for (const [name, value] of Object.entries(config.volumes)) value.name = `${config.name}_${name}`;
  for (const [index, name] of Object.keys(config.networks).entries()) {
    const value = config.networks[name];
    value.name = `${config.name}_${name}`;
    value.ipam = { config: [{ subnet: `10.252.${225 + Number(index)}.0/24` }] };
  }
  validateTopology(config);
  await writeJson(join(directory, 'compose.json'), composeLiteral(config));
  await writeJson(join(directory, 'environment.json'), { FOGD_COMPOSE_FILE: join(directory, 'compose.json'), COMPOSE_PROJECT_NAME: config.name, FOGD_SERVER: 'http://127.0.0.1:8920', FOGD_URL: 'http://127.0.0.1:8919', FOGD_TLS: '0', FOGD_PROFILE: 'local', FOGD_HTTP_PORT: '8919', FOGD_ADMIN_USER: 'admin', FOGD_ADMIN_PASSWORD: password, FOGD_DEPLOY_TOKEN: deploy, FOGD_GATEWAY_TOKEN: gateway, FOGD_BASE_DOMAIN: 'localhost' });
  const runner = join(directory, 'runner'); await mkdir(runner);
  await cp(new URL(profile === 'recovery' ? './controller.mjs' : '../retirement/controller.mjs', import.meta.url), join(runner, 'controller.mjs'));
  await cp(new URL('./commands.mjs', import.meta.url), join(runner, 'commands.mjs'));
  await cp(new URL('../../queue-probe/controller-artifact.mjs', import.meta.url), join(runner, 'controller-artifact.mjs'));
  const built = await stageFaultRefresh(join(directory, 'build'));
  await cp(built.output, join(runner, 'artifact'), { recursive: true });
  return { config, runner };
}
