import { devNull } from 'node:os';
import { inventory } from './inventory.mjs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configEnv, stackRoot } from '../local.mjs';
import { docker, json, composeArgs, projectContainers, projectName, stopped, volumeNames } from './docker.mjs';
import { fingerprint, writeJson, validateTopology, composeResolved } from './bundle.mjs';

export async function backup(directory) {
  const env = await configEnv();
  const file = resolve(env.FOGD_COMPOSE_FILE || join(stackRoot, 'compose.yaml'));
  const config = composeResolved(await json(['compose', '--env-file', devNull, '-f', file, 'config', '--format', 'json'], { env }));
  projectName(config.name); validateTopology(config);
  const volumes = volumeNames(config);
  const images = await inventory(config);
  const dir = resolve(directory); await mkdir(dir, { mode: 0o700 });
  const started = Date.now(), command = composeArgs(file, config.name);
  console.log(`Stopping ${config.name} for a complete installation snapshot`);
  await docker([...command, 'stop', 'workerd', 'controller'], { env });
  await docker([...command, 'stop', ...volumes.filter(name => name.startsWith('slot-'))], { env });
  await docker([...command, 'stop', 'minio', 'bucket-init'], { env });
  const names = volumes.map(name => config.volumes[name].name);
  await stopped(config.name, names);
  const stoppedAt = new Date().toISOString();
  const exits = (await projectContainers(config.name)).map(c => ({ service: c.Config.Labels['com.docker.compose.service'], exitCode: c.State.ExitCode, oomKilled: c.State.OOMKilled }));
  const crashes = exits.filter(c => c.service !== 'workerd' && (c.exitCode !== 0 || c.oomKilled));
  if (crashes.length) console.warn(`Snapshot requires crash recovery: ${crashes.map(c => `${c.service} (exit ${c.exitCode}, OOM ${c.oomKilled})`).join(', ')}`);
  await writeJson(join(dir, 'compose.json'), config);
  const files = {};
  for (const name of volumes) {
    await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--security-opt', 'no-new-privileges', '--mount', `type=volume,src=${config.volumes[name].name},dst=/data,readonly`, images.controller, 'tar', '--numeric-owner', '-C', '/data', '-cpf', '-', '.'], { output: join(dir, `${name}.tar`) });
  }
  await docker(['image', 'save', ...new Set(Object.values(images))], { output: join(dir, 'images.tar') });
  await stopped(config.name, names);
  for (const name of ['compose.json', 'images.tar', ...volumes.map(v => `${v}.tar`)]) files[name] = await fingerprint(join(dir, name));
  const manifest = { format: 'fogd-stopped-v1', sourceProject: config.name, stoppedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - started, exits, images, files };
  await writeJson(join(dir, 'manifest.json'), manifest);
  console.log(`Backup complete: ${dir}. Source remains stopped.`);
  return manifest;
}
