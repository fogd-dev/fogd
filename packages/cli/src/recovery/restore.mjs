import { recoveryOptions } from '../runtime/recovery-options.mjs';
import { assertDockerNetworkAvailability } from '../runtime/network-availability.mjs';
import { parseArgs } from 'node:util';
import { requestedRecoveryRuntime, selectedRecoveryPlan } from '../runtime/recovery-selection.mjs';
import { authorizeInstalledPolicy, verifyRuntimeFamily } from '../runtime/catalog.mjs';
import { writeRuntimeConfiguration, completeRuntimeRestore, hasRuntimeEnrollment } from '../runtime/installation-state.mjs';
import { writeRecoverySource } from '../runtime/recovery-source.mjs';
import { runtimePolicyIdentity } from '@fogd/platform/runtime-policy';
import { mkdir, rename, open, lstat } from 'node:fs/promises';
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

export async function restore(directory, project, output, selection = {}) {
  requestedRecoveryRuntime(selection);
  projectName(project);
  const dir = resolve(directory), destination = resolve(output);
  const { manifest, config } = await verifyBundle(dir);
  const selected = selectedRecoveryPlan({ manifest, config }, selection);
  return restoreInstallation({ manifest, config, dir }, project, destination, null, selected?.targetPolicy, { selected: Boolean(selected) });
}
export async function restoreInstallation({ manifest, config, dir }, project, destination, change = null, runtimeProfile = null, { selected = false } = {}) {
  if (await hasRuntimeEnrollment(project)) throw new Error('Installation enrollment already exists; retain it and choose a fresh project');
  await requireNewOutput(destination);
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
  if (change || selected) await stopped(manifest.sourceProject, sourceVolumes.map(name => config.volumes[name].name));
  await requireFresh(project, target);
  if (selected) await assertDockerNetworkAvailability(policy?.networks);
  const started = Date.now(), file = join(destination, 'compose.pending.json');
  await prepareRestoreRuntime({ manifest, config, dir }, images.controller, state, change, policy, target, selected, destination);
  await writeJson(file, composeLiteral(target));
  const command = composeArgs(file, project);
  await docker([...command, 'create', '--pull', 'never']);
  await stopped(project, volumes.map(name => target.volumes[name].name));
  await restoreSnapshotData(dir, target, manifest.images.controller, state, change?.skipped, policy);
  await finalizeRestore({ manifest, config }, target, destination, change, started, selected ? policy : null);
  return { config: target, policy, directory: destination };
}

async function prepareRestoreRuntime({ manifest, config, dir }, controller, state, change, policy, target, selected, destination) {
  if (selected) {
    await verifyRuntimeFamily(authorizeInstalledPolicy(policy));
    await requireStateRuntime(controller, state, change, policy, true);
    const env = target.services.controller.environment;
    console.log(`Selected recovery ingress: ${env.FOGD_PUBLIC_BIND_ADDRESS || '127.0.0.1'}; TLS ${env.FOGD_TLS === '1' ? 'enabled' : 'disabled'}. Review trusted snapshot exposure before startup.`);
  } else await loadRestoreImages(dir, manifest.images, controller, state, change, policy, hasRuntimePolicy(target));
  await mkdir(destination, { mode: 0o700 });
  if (selected) {
    await writeRuntimeConfiguration(target, { reserve: true, recovery: true });
    await writeRecoverySource(target.name, manifest.sourceProject, config);
  }
}

async function requireNewOutput(destination) {
  try { await lstat(destination); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Recovery output already exists; retain it and choose a fresh directory');
}

async function finalizeRestore({ manifest, config }, target, destination, change, started, policy) {
  if (change) {
    await writeJson(join(destination, `${change.kind}.json`), change.evidence);
  }
  if (change || policy) await stopped(manifest.sourceProject, volumeNames(config).map(name => config.volumes[name].name));
  await stopped(target.name, volumeNames(target).map(name => target.volumes[name].name));
  await rename(join(destination, 'compose.pending.json'), join(destination, 'compose.json'));
  const parent = await open(destination, 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  const selection = policy ? { runtimeFamily: policy.family, identitySha256: runtimePolicyIdentity(policy) } : {};
  await writeJson(join(destination, 'restored.json'), { ...selection, format: manifest.format, sourceProject: manifest.sourceProject, project: target.name, completedAt: new Date().toISOString(), durationMs: Date.now() - started, retirement: change?.kind === 'retirement' ? change.evidence.id : null, expansion: change?.kind === 'expansion' ? change.evidence.id : null });
  if (policy) await completeRuntimeRestore(target.name);
  console.warn('Restoring an older snapshot can resurrect application access, deploy credentials, and secret revisions. Keep the source stopped.');
  showRestoredInstallation(destination, target.name, policy);
}

function showRestoredInstallation(destination, project, policy) {
  const file = join(destination, 'compose.json');
  if (!policy) { console.log(`Restore complete, still stopped. Start with: docker compose -f ${file} -p ${project} up -d --pull never`); return; }
  console.log(`Restored ${policy.family}; installation identity ${runtimePolicyIdentity(policy)}. Services remain stopped. Keep the source stopped on every host. Retain the source operator environment for TLS trust, endpoint and credentials.`);
  console.log(`Start with: fogd up --installation ${project}`);
}

export async function restoreCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, output: { type: 'string' }, runtime: { type: 'string' }, 'expected-identity': { type: 'string' }, 'network-plan': { type: 'string' } } });
  if (positionals.length !== 1 || !values.project || !values.output) throw new Error('Usage: fogd restore BUNDLE --project NEW --output DIR [--runtime FAMILY --expected-identity SHA256 [--network-plan FILE]]');
  return restore(positionals[0], values.project, values.output, await recoveryOptions(values));
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
