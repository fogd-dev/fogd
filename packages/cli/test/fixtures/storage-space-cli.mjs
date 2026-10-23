import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeCli } from './runtime-cli.mjs';
import { prebootFixture } from './cron-preboot.mjs';
import { freshRuntimePlan } from '../../src/runtime/selection-plan.mjs';
const exec = promisify(execFile);
export async function spaceFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-space-')); t.after(() => rm(root, { recursive: true, force: true }));
  const client = await runtimeCli(root, 'qualified'), { source } = prebootFixture();
  for (const [role, service] of Object.entries(source.services)) service.image = role === 'minio' ? 'fogd-minio:local' : 'fogd-runtime:local';
  const { config } = freshRuntimePlan(source, client.entry), directory = join(root, '.fogd/installations', config.name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'compose.json'); await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const data = join(root, 'data.json'), log = join(root, 'calls.jsonl'), bin = join(root, 'bin'); await mkdir(bin);
  await writeFile(data, JSON.stringify({ config, entry: client.entry }));
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nexec "$FOGD_TEST_NODE" "$FOGD_TEST_DRIVER" "$@"\n', { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FOGD_HOME: root, FOGD_ENV_FILE: join(root, 'must-not-exist.env'),
    FOGD_ADMIN_PASSWORD: 'private-host-admin', FOGD_DEPLOY_TOKEN: 'private-host-token', COMPOSE_PROJECT_NAME: 'wrong-project', FOGD_COMPOSE_FILE: '/private/wrong-template',
    FOGD_TEST_NODE: process.execPath, FOGD_TEST_DRIVER: new URL('./storage-space-docker.mjs', import.meta.url).pathname, FOGD_SPACE_DATA: data, FOGD_TEST_LOG: log };
  return { root, directory, file, data, log, config, env,
    run: (args = ['space', '--installation', config.name], extra = {}) => exec(process.execPath, [client.cli, 'storage', ...args], { env: { ...env, ...extra }, timeout: 20000 }),
    calls: async () => (await readFile(log, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(JSON.parse) };
}
