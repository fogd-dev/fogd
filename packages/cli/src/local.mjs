import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile, rename, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { stageArtifact, appName } from '@fogd/runtime/artifact';

export const stackRoot = resolve(process.env.FOGD_HOME || fileURLToPath(new URL('../../../', import.meta.url)));
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function configEnv() {
  let local = {};
  try { local = parseEnv(await readFile(join(stackRoot, '.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...local, ...process.env };
}
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(command, args, { cwd: options.cwd || stackRoot, env: options.env || process.env, stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    child.stdout?.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}`)));
  });
}
export const compose = (args, env, capture = false) => run('docker', ['compose', '--project-directory', stackRoot, '-f', join(stackRoot, 'compose.yaml'), ...args], { env, capture });
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
export async function buildArtifact(projectDir, nameOverride) {
  const project = resolve(projectDir);
  const settings = await readJson(join(project, 'fogd.json'), {});
  const pkg = await readJson(join(project, 'package.json'), {});
  const app = appName(nameOverride || settings.name || pkg.name?.split('/').at(-1));
  const buildEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLOUDFLARE_|CF_|AWS_|MINIO_)/i.test(key) && !/^FOGD_.*(TOKEN|PASSWORD|SECRET)/i.test(key)));
  await run(process.execPath, [fileURLToPath(new URL('./build.mjs', import.meta.url)), project], { cwd: project, env: buildEnv });
  const parent = join(stackRoot, '.fogd', 'releases', app);
  await mkdir(parent, { recursive: true });
  const outputDir = join(parent, randomUUID());
  const release = await stageArtifact({ projectDir: project, outputDir, app, buildOutput: settings.buildOutput, migrationsDir: settings.migrationsDir });
  return { ...release, outputDir };
}
export async function up() {
  const active = await readJson(join(stackRoot, '.fogd', 'local.json'), {});
  const env = { ...await configEnv(), ...active.env };
  await compose(['up', '-d', '--build'], env);
  console.log(`Local stack started. Deploy a Void app with fogd deploy.`);
}
export async function deployLocal(projectDir, nameOverride) {
  const release = await buildArtifact(projectDir, nameOverride);
  const lockPath = join(stackRoot, '.fogd', 'deploy.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Another deploy holds ${lockPath}. Remove only after confirming it has stopped.`); throw error; }
  try {
    const statePath = join(stackRoot, '.fogd', 'apps', `${release.app}.json`);
    const previous = await readJson(statePath, null);
    if (previous && JSON.stringify(previous.resources) !== JSON.stringify(release.resources)) throw new Error('Resource identities changed; an explicit migration is required');
    for (const migration of previous?.migrations || []) {
      const next = release.migrations.find(item => item.database === migration.database && item.name === migration.name);
      if (!next || next.digest !== migration.digest) throw new Error(`Previously deployed migration changed: ${migration.name}`);
    }
    const base = await configEnv();
    const appEnv = { FOGD_APP: release.app, FOGD_APP_HOST: `${release.app}.${base.FOGD_BASE_DOMAIN || 'localhost'}`, FOGD_ARTIFACT_DIR: release.outputDir };
    const env = { ...base, ...appEnv };
    await compose(['up', '-d', '--build', 'minio', 'bucket-init'], env);
    const migrate = async () => {
      for (const database of release.resources.d1) await compose(['run', '--rm', 'deployer', 'd1', 'migrations', 'apply', database.database_name, '/artifact'], env);
    };
    const active = await readJson(join(stackRoot, '.fogd', 'local.json'), {});
    if (previous && active.env?.FOGD_APP !== release.app) {
      await compose(['up', '-d', 'celld-a', 'celld-b'], env);
      await waitReplicas(env);
    }
    if (previous) await migrate();
    const raw = await compose(['run', '--rm', 'deployer', 'deploy', '/artifact', '--json'], env, true);
    const deployment = JSON.parse(raw.trim().split('\n').at(-1));
    await compose(['up', '-d', 'celld-a', 'celld-b'], env);
    await waitReplicas(env, deployment.version);
    if (!previous) await migrate();
    await compose(['up', '-d', 'workerd'], env);
    await atomicJson(statePath, { ...release, version: deployment.version });
    await atomicJson(join(stackRoot, '.fogd', 'local.json'), { env: appEnv });
    console.log(`Deployed ${release.app} (${deployment.version}) at http://${appEnv.FOGD_APP_HOST}:${base.FOGD_HTTP_PORT || 8787}`);
  } finally { await lock.close(); await unlink(lockPath); }
}
export async function waitReplicas(env, version) {
  const expected = JSON.stringify(version || null);
  await compose(['exec', '-T', 'celld-a', 'node', '--input-type=module', '-e', `
    const expected = ${expected};
    for (const host of ['celld-a','celld-b']) {
      let last;
      for (let attempt=0;attempt<180;attempt++) {
        try {
          const health = await fetch('http://'+host+':8080/.well-known/celld/health', {signal:AbortSignal.timeout(3000)});
          if (!health.ok) throw new Error('Not healthy');
          if (expected) {
            const result = await fetch('http://'+host+':8081/reload',{method:'POST',signal:AbortSignal.timeout(15000)});
            const state=await result.json();
            if (!result.ok || state.version!==expected) throw new Error(JSON.stringify(state));
          }
          console.log(host+' ready'+(expected?' at '+expected:'')); last=null; break;
        } catch(error) { last=error; await new Promise(resolve=>setTimeout(resolve,1000)); }
      }
      if(last) throw last;
    }
  `], env);
}
