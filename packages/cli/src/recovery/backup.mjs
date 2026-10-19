import { resolvedCompose } from '../compose/config.mjs';
import { recoveryLayout } from './layout.mjs';
import { inventory } from './inventory.mjs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { requireDocker, configEnv, stackRoot } from '../local.mjs';
import { docker, composeArgs, projectContainers, projectName, stopped } from './docker.mjs';
import { fingerprint, writeJson, validateTopology } from './bundle.mjs';
import { queueBackupApps, prepareQueueBackup, queueSnapshotEvidence } from './queue-backup.mjs';
import { snapshotState } from './snapshot-state.mjs';
import { volumeHelper } from './volumes.mjs';

export async function backup(directory) {
  const env = await configEnv();
  requireDocker(env);
  const file = resolve(env.FOGD_COMPOSE_FILE || join(stackRoot, 'compose.yaml'));
  const config = await resolvedCompose(env);
  projectName(config.name); validateTopology(config);
  const layout = recoveryLayout(config), { volumes } = layout;
  const images = await inventory(config);
  let state;
  try { state = JSON.parse(await volumeHelper(images.controller, config.volumes.controller.name, ['cat', '/data/state.json'])); }
  catch { throw new Error('Cannot read controller metadata for recovery'); }
  const queues = queueBackupApps(state);
  const dir = resolve(directory); await mkdir(dir, { mode: 0o700 });
  if (queues.length) console.warn('Preparing queue pause. If backup fails, inspect delivery status: queues may remain operator-paused and require explicit resume.');
  const prepared = await prepareQueueBackup(env, state, images, layout.replicas);
  const started = Date.now(), command = composeArgs(file, config.name);
  console.log(`Stopping ${config.name} for a complete installation snapshot`);
  await docker([...command, 'stop', 'workerd', 'controller'], { env });
  await docker([...command, 'stop', ...layout.replicas], { env });
  await docker([...command, 'stop', 'minio', 'bucket-init'], { env });
  const names = volumes.map(name => config.volumes[name].name);
  await stopped(config.name, names);
  const stoppedAt = new Date().toISOString();
  const exits = (await projectContainers(config.name)).map(c => ({ service: c.Config.Labels['com.docker.compose.service'], exitCode: c.State.ExitCode, oomKilled: c.State.OOMKilled }));
  const crashes = exits.filter(c => c.service !== 'workerd' && (c.exitCode !== 0 || c.oomKilled));
  if (crashes.length) console.warn(`Snapshot requires crash recovery: ${crashes.map(c => `${c.service} (exit ${c.exitCode}, OOM ${c.oomKilled})`).join(', ')}`);
  await writeJson(join(dir, 'compose.json'), config);
  const files = {};
  let queueRecovery;
  for (const name of ['controller', ...volumes.filter(name => name !== 'controller')]) {
    await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--security-opt', 'no-new-privileges', '--mount', `type=volume,src=${config.volumes[name].name},dst=/data,readonly`, images.controller, 'tar', '--numeric-owner', '-C', '/data', '-cpf', '-', '.'], { output: join(dir, `${name}.tar`) });
    if (name === 'controller') queueRecovery = queueSnapshotEvidence(await snapshotState(dir), prepared);
  }
  await docker(['image', 'save', ...new Set(Object.values(images))], { output: join(dir, 'images.tar') });
  await stopped(config.name, names);
  for (const name of layout.archives) files[name] = await fingerprint(join(dir, name));
  if (queueRecovery) queueSnapshotEvidence(await snapshotState(dir), prepared);
  const manifest = { format: 'fogd-stopped-v1', sourceProject: config.name, stoppedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - started, exits, images, files, ...(queueRecovery ? { queueRecovery } : {}) };
  await writeJson(join(dir, 'manifest.json'), manifest);
  console.log(`Backup complete: ${dir}. Source remains stopped.`);
  return manifest;
}
