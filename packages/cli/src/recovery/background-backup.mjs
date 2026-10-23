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
import { validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { routeAuthorityCapability } from '@fogd/platform/route-snapshot';

const families = [
  { key: 'queueRecovery', surface: 'delivery', apps: queueRecoveryApps, protocol: queueSnapshotProtocol },
  { key: 'cronRecovery', surface: 'dispatch', apps: cronRecoveryApps, protocol: cronSnapshotProtocol },
];
const capabilities = ['fogd-retirement-v1', 'fogd-claim-intent-v1', 'fogd-queue-activation-v1', queueRecoveryCapability, queueRetirementCapability, cronCapability, cronRecoveryCapability, cronRetirementCapability];
// Only a validated schema 3 durable profile admits durable route authority state.
function supportedCapabilities(profile) {
  if (profile === undefined) return capabilities;
  const policy = validateRuntimePolicy(profile);
  return policy.schema === 3 && policy.routing === 'durable' ? [...capabilities, routeAuthorityCapability] : capabilities;
}
export function backgroundBackupApps(state, profile) {
  assertSnapshotState(state, supportedCapabilities(profile));
  return Object.fromEntries(families.map(family => [family.key, family.apps(state)]));
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
