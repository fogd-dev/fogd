import { assertPinnedSnapshotImages } from './snapshot-evidence.mjs';
import { maintenanceConfiguration } from '../runtime/maintenance.mjs';
import { recoveryLayout } from './layout.mjs';
import { inventory } from './inventory.mjs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { requireDocker, configEnv, stackRoot } from '../local.mjs';
import { docker, projectContainers, projectName, stopped } from './docker.mjs';
import { fingerprint, writeJson, validateTopology } from './bundle.mjs';
import { backgroundBackupApps, prepareBackgroundBackup, backgroundSnapshotEvidence } from './background-backup.mjs';
import { snapshotState } from './snapshot-state.mjs';
import { volumeHelper } from './volumes.mjs';
import { assertCronDockerTopology } from './cron-backup.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { selectedInstallation } from '../runtime/installation.mjs';
import { stopRuntimeServices } from '../runtime/stop.mjs';
import { backupDurableInstallation } from './durable-backup.mjs';

export async function backup(directory, installation) {
  const profile = await configEnv();
  requireDocker(profile);
  const raw = await maintenanceConfiguration(profile, installation), selected = await selectedInstallation(raw);
  const env = installation === undefined ? profile : { ...profile, ...raw.services.controller.environment };
  const file = selected?.file || resolve(env.FOGD_COMPOSE_FILE || join(stackRoot, 'compose.yaml'));
  const config = selected?.config || raw;
  if (selected) console.log(`Record independently for recovery: runtime ${selected.entry.id}; installation identity ${runtimePolicyIdentity(selected.policy)}`);
  if (selected?.policy.schema === 3) {
    const manifest = await backupDurableInstallation(directory, selected, env);
    console.log(`Durable snapshot complete: ${resolve(directory)}. Source remains stopped. Restore requires the durable recovery path.`);
    return manifest;
  }
  projectName(config.name); validateTopology(config);
  const layout = recoveryLayout(config), { volumes, archiveVolumes } = layout;
  const images = await inventory(config);
  let state;
  try { state = JSON.parse(await volumeHelper(images.controller, config.volumes.controller.name, ['cat', '/data/state.json'])); }
  catch { throw new Error('Cannot read controller metadata for recovery'); }
  assertCronDockerTopology(state, config);
  const background = backgroundBackupApps(state);
  assertPinnedSnapshotImages(Object.values(background).flat(), images, layout.replicas);
  const dir = resolve(directory); await mkdir(dir, { mode: 0o700 });
  if (Object.values(background).some(names => names.length)) console.warn('Preparing background dispatch pause. If backup fails, inspect delivery and scheduled dispatch status: apps may remain operator-paused and require explicit resume. Cron pause clears timer and retry identity.');
  const prepared = await prepareBackgroundBackup(env, state, images, layout.replicas);
  const started = Date.now();
  console.log(`Stopping ${config.name} for a complete installation snapshot`);
  await stopRuntimeServices(config, file, { env });
  const names = volumes.map(name => config.volumes[name].name);
  await stopped(config.name, names);
  const stoppedAt = new Date().toISOString();
  const exits = (await projectContainers(config.name)).map(c => ({ service: c.Config.Labels['com.docker.compose.service'], exitCode: c.State.ExitCode, oomKilled: c.State.OOMKilled }));
  const crashes = exits.filter(c => c.service !== 'workerd' && (c.exitCode !== 0 || c.oomKilled));
  if (crashes.length) console.warn(`Snapshot requires crash recovery: ${crashes.map(c => `${c.service} (exit ${c.exitCode}, OOM ${c.oomKilled})`).join(', ')}`);
  await writeJson(join(dir, 'compose.json'), config);
  const files = {};
  let evidence;
  for (const name of ['controller', ...archiveVolumes.filter(name => name !== 'controller')]) {
    await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--security-opt', 'no-new-privileges', '--mount', `type=volume,src=${config.volumes[name].name},dst=/data,readonly`, images.controller, 'tar', '--numeric-owner', '-C', '/data', '-cpf', '-', '.'], { output: join(dir, `${name}.tar`) });
    if (name === 'controller') evidence = backgroundSnapshotEvidence(await snapshotState(dir), prepared);
  }
  await docker(['image', 'save', ...new Set(Object.values(images))], { output: join(dir, 'images.tar') });
  await stopped(config.name, names);
  for (const name of layout.archives) files[name] = await fingerprint(join(dir, name));
  backgroundSnapshotEvidence(await snapshotState(dir), prepared);
  const manifest = { format: 'fogd-stopped-v1', sourceProject: config.name, stoppedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - started, exits, images, files, ...evidence };
  await writeJson(join(dir, 'manifest.json'), manifest);
  console.log(`Backup complete: ${dir}. Source remains stopped.`);
  return manifest;
}
