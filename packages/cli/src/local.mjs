import { devNull } from 'node:os';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { stageManagedBuild } from './build-cache/lifecycle.mjs';
import { buildEnvironment } from './build-env.mjs';
import { appName } from '@fogd/runtime/artifact';

export const stackRoot = resolve(process.env.FOGD_HOME || fileURLToPath(new URL('../../../', import.meta.url)));
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export const configPath = () => resolve(process.env.FOGD_ENV_FILE || join(stackRoot, '.env'));
export async function configEnv() {
  let local = {};
  try { local = parseEnv(await readFile(configPath(), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...local, ...process.env };
}
export const serverOrigin = env => env.FOGD_SERVER || `${env.FOGD_TLS === '1' ? 'https' : 'http'}://127.0.0.1:${env.FOGD_ADMIN_PORT || 8788}`;
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(command, args, { cwd: options.cwd || stackRoot, env: options.env || process.env, stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    child.stdout?.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}`)));
  });
}
export function requireDocker(env) {
  if (env.FOGD_TOPOLOGY && env.FOGD_TOPOLOGY !== 'docker') throw new Error('This command supports Docker installations only; Kubernetes PVC recovery requires its own adapter');
}
export const compose = (args, env, capture = false) => run('docker', ['compose', '--env-file', devNull, '--project-directory', stackRoot, '-f', resolve(env.FOGD_COMPOSE_FILE || join(stackRoot, 'compose.yaml')), ...args], { env, capture });
export async function artifactProject(projectDir, nameOverride) {
  const project = resolve(projectDir);
  const settings = await readJson(join(project, 'fogd.json'), {});
  const pkg = await readJson(join(project, 'package.json'), {});
  const app = appName(nameOverride || settings.name || pkg.name?.split('/').at(-1));
  return { project, settings, app };
}
export async function buildArtifact(projectDir, nameOverride, capabilities) {
  const { project, settings, app } = await artifactProject(projectDir, nameOverride);
  const buildEnv = buildEnvironment();
  await run(process.execPath, [fileURLToPath(new URL('./build.mjs', import.meta.url)), project], { cwd: project, env: buildEnv });
  return stageManagedBuild(stackRoot, { app, project, settings, capabilities });
}
