import { appArchiveCapability, validateAppArchives } from '@fogd/platform/app-archive';
import { decisionHistoryCapability } from '@fogd/platform/decision-history';
import { artifactPruneCapability } from '@fogd/platform/artifact-prune-state';
import { queueRecoveryApps, queueSnapshotProtocol } from './queue-backup.mjs';
import { cronRecoveryApps, cronSnapshotProtocol } from './cron-backup.mjs';
import { cronRetirementCapability } from '@fogd/platform/cron-retirement';
import { cronCapability } from '@fogd/platform/cron-history';
import { cronRecoveryCapability } from '@fogd/platform/cron-snapshot';
import { queueRecoveryCapability } from '@fogd/platform/queue-snapshot';
import { queueRetirementCapability } from '@fogd/platform/queue-retirement';
import { assertSnapshotState } from './snapshot-state-validation.mjs';
import { snapshotEvidence, validateSnapshotEvidence, assertPinnedSnapshotImages } from './snapshot-evidence.mjs';
import { prepareSnapshotRequest } from '../platform.mjs';
import { hasDurableRuntimeMode, validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { routeAuthorityCapability } from '@fogd/platform/route-snapshot';

const families = [
  { key: 'queueRecovery', surface: 'delivery', apps: queueRecoveryApps, protocol: queueSnapshotProtocol },
  { key: 'cronRecovery', surface: 'dispatch', apps: cronRecoveryApps, protocol: cronSnapshotProtocol },
];
const capabilities = [decisionHistoryCapability, artifactPruneCapability, 'fogd-retirement-v1', 'fogd-claim-intent-v1', 'fogd-queue-activation-v1', queueRecoveryCapability, queueRetirementCapability, cronCapability, cronRecoveryCapability, cronRetirementCapability];
// Only a validated durable profile admits durable route authority state.
function supportedCapabilities(profile) {
  if (profile === undefined) return capabilities;
  const policy = validateRuntimePolicy(profile);
  return hasDurableRuntimeMode(policy) ? [...capabilities, routeAuthorityCapability] : capabilities;
}
function backgroundApps(state, profile, archives) {
  const capabilities = supportedCapabilities(profile);
  assertSnapshotState(state, archives ? [...capabilities, appArchiveCapability] : capabilities);
  if (!archives && (Object.hasOwn(state, 'appArchives') || Object.values(state.apps).some(app => app.archive || app.archiveRecovery || app.route === 'archived'))) throw new Error('App archive state requires the archive runtime mode');
  const records = archives ? validateAppArchives(state, profile) : {};
  const archived = Object.values(records).filter(record => record.status === 'archived').map(record => record.name);
  return Object.fromEntries(families.map(family => [family.key, family.apps(state, archived)]));
}
export function backgroundBackupApps(state, profile) {
  return backgroundApps(state, profile, profile?.schema === 4);
}
export async function prepareBackgroundBackup(env, state, images, replicas, profile) {
  const inventory = backgroundBackupApps(state, profile), expected = {};
  // Validate both families and every image before the first pause request.
  assertPinnedSnapshotImages(Object.values(inventory).flat(), images, replicas);
  for (const family of families) {
    expected[family.key] = {};
    for (const name of inventory[family.key]) {
      const active = state.deployments[state.apps[name].active];
      const receipt = await prepareSnapshotRequest(env, name, { deployment: active.id, digest: active.digest }, family.surface);
      expected[family.key][name] = receipt.id;
    }
  }
  return expected;
}
export function backgroundSnapshotEvidence(state, expected, now = Date.now(), profile) {
  const inventory = backgroundBackupApps(state, profile), evidence = {};
  for (const family of families) {
    const receipt = snapshotEvidence(state, inventory[family.key], expected[family.key], family.protocol, now);
    if (receipt) evidence[family.key] = receipt;
  }
  return evidence;
}
export function validateBackgroundEvidence(state, manifest, now = Date.now(), profile) {
  const inventory = backgroundBackupApps(state, profile);
  for (const family of families) validateSnapshotEvidence(state, manifest[family.key], inventory[family.key], family.protocol, now);
  return inventory;
}

// The source-only archive verifier also checks earlier internal archive profiles.
// Public durable backup admits this protocol only in the fixed archive mode.
export function validateAppArchiveBackgroundEvidence(state, manifest, now, profile) {
  const inventory = backgroundApps(state, profile, true);
  for (const family of families) validateSnapshotEvidence(state, manifest[family.key], inventory[family.key], family.protocol, now);
  return inventory;
}
