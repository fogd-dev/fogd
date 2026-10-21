import { mkdir, rename, open } from 'node:fs/promises';
import { restoreVolumes, volumeHelper } from './volumes.mjs';
import { retirementCapability } from '@fogd/platform/retirement';
import { join, resolve } from 'node:path';
import { docker, json, composeArgs, requireFresh, projectName, stopped, volumeNames } from './docker.mjs';
import { verifyBundle, restoredConfig, composeLiteral, writeJson, validateTopology } from './bundle.mjs';
import { restoredInstallationState } from './background-restore.mjs';
import { assertPinnedSnapshotImages } from './snapshot-evidence.mjs';
import { recoveryLayout, hasRuntimePolicy } from './layout.mjs';
import { installRuntimePolicy } from '../runtime/install-policy.mjs';
import { cronRetirementCapability } from '@fogd/platform/cron-retirement';
import { cronCapability } from '@fogd/platform/cron-history';
import { cronRecoveryCapability } from '@fogd/platform/cron-snapshot';
import { queueRetirementCapability } from '@fogd/platform/queue-retirement';
import { queueRecoveryCapability } from '@fogd/platform/queue-snapshot';
import { assertCronDockerTopology } from './cron-backup.mjs';
import { restoredRuntimeConfig } from '../runtime/cron-preboot.mjs';
import { verifyCronRuntimeImage, verifyCronStorageImage } from '../runtime/cron-image.mjs';
import { hasCronHistory } from '@fogd/platform/cron-history';

export async function restore(directory, project, output) {
  projectName(project);
  const dir = resolve(directory), destination = resolve(output);
  const { manifest, config } = await verifyBundle(dir);
  return restoreInstallation({ manifest, config, dir }, project, destination);
}
export async function restoreInstallation({ manifest, config, dir }, project, destination, change = null, runtimeProfile = null) {
  const policy = runtimeProfile && structuredClone(runtimeProfile);
  const state = await restoredInstallationState(dir, manifest, change);
  assertCronDockerTopology(state, config);
  if (change?.config) assertCronDockerTopology(state, change.config);
  const background = Object.keys(state?.apps || {}).filter(name => state.apps[name].queueRecovery?.status === 'pending' || state.apps[name].cronRecovery?.status === 'pending');
  assertPinnedSnapshotImages(background, manifest.images, recoveryLayout(config).replicas);
  const sourceVolumes = volumeNames(config), images = change?.images || manifest.images;
  if (change && !['retirement', 'expansion'].includes(change.kind)) throw new Error('Unknown installation transformation');
  if (Object.values(images).some(id => !Object.values(manifest.images).includes(id))) throw new Error('Transformation may only use snapshot images');
  if (project === manifest.sourceProject) throw new Error('Restore requires a different project from its source');
  const base = restoredConfig(change?.config || config, project, images);
  validateTopology(base);
  const target = restoredRuntimeConfig(state, base, policy);
  const volumes = volumeNames(target);
  if (change) await stopped(manifest.sourceProject, sourceVolumes.map(name => config.volumes[name].name));
  await requireFresh(project, target);
  const started = Date.now(), file = join(destination, 'compose.pending.json');
  await loadRestoreImages(dir, manifest.images, images.controller, state, change, policy, hasRuntimePolicy(target));
  await mkdir(destination, { mode: 0o700 });
  await writeJson(file, composeLiteral(target));
  const command = composeArgs(file, project);
  await docker([...command, 'create', '--pull', 'never']);
  await stopped(project, volumes.map(name => target.volumes[name].name));
  await restoreSnapshotData(dir, target, manifest.images.controller, state, change?.skipped, policy);
  if (change) {
    await writeJson(join(destination, `${change.kind}.json`), change.evidence);
    await stopped(manifest.sourceProject, sourceVolumes.map(name => config.volumes[name].name));
  }
  await stopped(project, volumes.map(name => target.volumes[name].name));
  await rename(file, join(destination, 'compose.json'));
  const parent = await open(destination, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  await writeJson(join(destination, 'restored.json'), { format: manifest.format, sourceProject: manifest.sourceProject, project, completedAt: new Date().toISOString(), durationMs: Date.now() - started, retirement: change?.kind === 'retirement' ? change.evidence.id : null, expansion: change?.kind === 'expansion' ? change.evidence.id : null });
  console.warn('Restoring an older snapshot can resurrect application access, deploy credentials, and secret revisions. Keep the source stopped.');
  console.log(`Restore complete, still stopped. Start with: docker compose -f ${join(destination, 'compose.json')} -p ${project} up -d --pull never`);
}

async function restoreSnapshotData(dir, target, image, state, skipped, policy) {
  await restoreVolumes(dir, target, volumeNames(target), image, skipped);
  if (state) await writeRecoveredState(target, image, state);
  if (hasRuntimePolicy(target)) await installRuntimePolicy(target, policy);
}

async function loadRestoreImages(dir, snapshotImages, controller, state, change, policy, installedPolicy) {
  await docker(['image', 'load'], { input: join(dir, 'images.tar') });
  const loaded = await json(['image', 'inspect', ...new Set(Object.values(snapshotImages))]);
  if (Object.values(snapshotImages).some(id => !loaded.some(image => image.Id === id))) throw new Error('Restored image identity mismatch');
  await requireStateRuntime(controller, state, change, policy, installedPolicy);
}

export function requiredCapabilities(state, change) {
  const required = [];
  if (change?.kind === 'retirement') required.push(['retirement', 'retirementCapability', retirementCapability]);
  if (state?.requirements?.includes(queueRecoveryCapability)) required.push(['queue-snapshot', 'queueRecoveryCapability', queueRecoveryCapability]);
  if (state?.requirements?.includes(queueRetirementCapability)) required.push(['queue-retirement', 'queueRetirementCapability', queueRetirementCapability]);
  if (state?.requirements?.includes(cronCapability)) required.push(['cron-dispatch', 'cronCapability', cronCapability]);
  if (state?.requirements?.includes(cronRecoveryCapability)) required.push(['cron-snapshot', 'cronRecoveryCapability', cronRecoveryCapability]);
  if (state?.requirements?.includes(cronRetirementCapability)) required.push(['cron-retirement', 'cronRetirementCapability', cronRetirementCapability]);
  return required;
}
async function requireStateRuntime(image, state, change, runtimeProfile, installedPolicy) {
  if (installedPolicy || (state && hasCronHistory(state))) {
    await verifyCronStorageImage(runtimeProfile.storageImage);
    await verifyCronRuntimeImage(runtimeProfile);
  }
  const required = requiredCapabilities(state, change);
  if (!required.length) return;
  const code = `const required = ${JSON.stringify(required)}; for (const [file, key, expected] of required) { const module = await import('./packages/platform/src/' + file + '.mjs'); if(module[key] !== expected) throw new Error('Capability mismatch'); } console.log('supported');`;
  let capability;
  try { capability = await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', image, 'node', '--input-type=module', '-e', code]); }
  catch { throw new Error('Snapshot runtime does not support required recovery capabilities; upgrade the source and take a new snapshot'); }
  if (capability.trim() !== 'supported') throw new Error('Snapshot recovery capability differs from the CLI');
}

async function writeRecoveredState(target, image, state) {
  const code = "import {saveJson} from './packages/platform/src/store.mjs'; let input=''; for await(const part of process.stdin) input+=part; await saveJson('/data/state.json', JSON.parse(input));";
  await volumeHelper(image, target.volumes.controller.name, ['node', '--input-type=module', '-e', code], { readonly: false, inputText: JSON.stringify(state) });
  const output = await volumeHelper(image, target.volumes.controller.name, ['cat', '/data/state.json']);
  if (JSON.stringify(JSON.parse(output)) !== JSON.stringify(state)) throw new Error('Restored controller metadata verification failed');
}
