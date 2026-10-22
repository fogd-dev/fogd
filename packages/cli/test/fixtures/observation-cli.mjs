import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeCli } from './runtime-cli.mjs';
import { prebootFixture } from './cron-preboot.mjs';
import { freshRuntimePlan } from '../../src/runtime/selection-plan.mjs';
const exec = promisify(execFile);
export const observationId = '00000000-0000-4000-8000-000000000001';
export async function observationFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-observation-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cli = await runtimeCli(root, 'qualified'), { source } = prebootFixture();
  for (const [role, service] of Object.entries(source.services)) service.image = role === 'minio' ? 'fogd-minio:local' : 'fogd-runtime:local';
  const plan = freshRuntimePlan(source, cli.entry), directory = join(root, '.fogd/installations', source.name);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(join(directory, 'compose.json'), JSON.stringify(plan.config), { mode: 0o600 });
  const state = { apps: { sample: { active: observationId, route: 'active', slot: 'slot-1' } }, deployments: { [observationId]: { id: observationId, app: 'sample', digest: 'a'.repeat(64), status: 'active', step: 'complete', version: 'private-runtime-version' } }, secrets: { sample: 'private-app-secret' }, credentials: 'private-deploy-credentials' };
  const data = join(root, 'data.json'), log = join(root, 'calls.jsonl');
  await writeFile(data, JSON.stringify({ ...plan, entry: cli.entry, state }));
  const bin = join(root, 'bin'); await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nexec "$FOGD_TEST_NODE" "$FOGD_TEST_DRIVER" "$@"\n', { mode: 0o700 });
  const driver = new URL('./observation-docker.mjs', import.meta.url).pathname;
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FOGD_HOME: root, FOGD_TEST_NODE: process.execPath, FOGD_TEST_DRIVER: driver, FOGD_OBSERVE_TEST_DATA: data, FOGD_TEST_LOG: log };
  return { root, plan, state, env, data, log, project: source.name,
    invoke: (args = ['sample', '--installation', source.name], extra = {}) => exec(process.execPath, [cli.cli, 'observe', ...args], { env: { ...env, ...extra }, timeout: 20000 }),
    calls: async () => (await readFile(log, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).trim().split('\n').filter(Boolean).map(JSON.parse),
  };
}
