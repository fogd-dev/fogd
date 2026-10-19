import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { compose } from '../../packages/cli/src/local.mjs';
import { resolvedCompose } from '../../packages/cli/src/compose/config.mjs';
import { docker, json, projectContainers } from '../../packages/cli/src/recovery/docker.mjs';

const [directory, project] = process.argv.slice(2);
assert.ok(directory); assert.match(project || '', /^fogd-m11[a-z0-9-]*$/);
assert.equal((await projectContainers(project)).length, 0, 'Use a fresh project');
for (const kind of ['volume', 'network']) assert.equal((await docker([kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])).trim(), '', 'Use fresh resources');
const output = resolve(directory); await mkdir(output, { mode: 0o700 });
const settings = { COMPOSE_PROJECT_NAME: project, FOGD_PROFILE: 'local', FOGD_TLS: '0', FOGD_TOPOLOGY: 'docker', FOGD_BIND_ADDRESS: '127.0.0.1', FOGD_BASE_DOMAIN: 'localhost', FOGD_HTTP_PORT: process.env.FOGD_PROBE_HTTP_PORT || '8899', FOGD_ADMIN_PORT: process.env.FOGD_PROBE_ADMIN_PORT || '8900', FOGD_ADMIN_USER: 'admin', FOGD_BUCKET_USER: project };
for (const port of [settings.FOGD_HTTP_PORT, settings.FOGD_ADMIN_PORT]) assert.ok(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535, 'Use valid probe ports');
assert.notEqual(settings.FOGD_HTTP_PORT, settings.FOGD_ADMIN_PORT);
for (const key of ['FOGD_ADMIN_PASSWORD', 'FOGD_DEPLOY_TOKEN', 'FOGD_GATEWAY_TOKEN', 'FOGD_BUCKET_PASSWORD']) settings[key] = randomBytes(32).toString('hex');
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FOGD_|CELLD_|COMPOSE_|AWS_|MINIO_|S3_|CF_|CLOUDFLARE_)/.test(key))), ...settings };
await compose(['build'], env);
const config = await resolvedCompose(env);
for (const [name, service] of Object.entries(config.services)) {
  const [image] = await json(['image', 'inspect', service.image]);
  service.image = image.Id; delete service.build;
  if (/^slot-\d-[ab]$/.test(name)) service.environment.CELLD_HANDLER_BUDGET_S = '20';
}
settings.FOGD_COMPOSE_FILE = join(output, 'compose.json');
await writeFile(settings.FOGD_COMPOSE_FILE, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
await writeFile(join(output, 'probe.env'), Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log(`Prepared private, image-pinned two-fleet fixture. Set FOGD_ENV_FILE to ${join(output, 'probe.env')} and run fogd up.`);
