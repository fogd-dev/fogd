import { mkdir } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes, privateJSON, exists } from '../build-cache/paths.mjs';
import { bindHostDirectory, checkHostDirectory, syncHostDirectory } from '../runtime/host-directory.mjs';
import { readPreviewHost } from './host-inventory.mjs';
import { refusePreviewProfile, profileInitialization, profileCompletion, validateProfileTarget, previewProfileEngineId, readPreviewProfileState } from './profile-records.mjs';
import { initializePreviewHost } from './host-reservations.mjs';
import { acquirePreviewHost } from './host-registry.mjs';
import { assertRegisteredPreviewResources } from './host-records.mjs';
import { initializePreviewStorageAdmission, inspectPreviewStorageAdmission } from './storage-admission.mjs';

async function freshOutput(output) {
  if (typeof output !== 'string' || !output) refusePreviewProfile();
  const parent = await bindHostDirectory(dirname(resolve(output))), directory = join(parent.canonical, basename(resolve(output)));
  if (await exists(directory)) refusePreviewProfile();
  return { parent, directory };
}
function policyMatches(profile, admission) {
  if (!isDeepStrictEqual(profile.storagePolicy, admission.policy) || admission.pending) refusePreviewProfile();
}

// Fresh setup only. Intent is durable before host effects. Any later failure
// retains the initialized policy, partial ledger and original local directory.
export async function initializePreviewProfile(input) {
  try {
    input = { ...input }; validateProfileTarget(input);
    if (typeof input.run !== 'function' || typeof input.runHost !== 'function') refusePreviewProfile();
    const output = await freshOutput(input.output), observed = await readPreviewHost(input.run), engineId = previewProfileEngineId(observed);
    assertRegisteredPreviewResources(observed, []);
    await checkHostDirectory(output.parent); await mkdir(output.directory, { mode: 0o700 }); await syncHostDirectory(output.parent);
    const bound = await bindHostDirectory(output.directory), original = profileInitialization(bound.canonical, randomUUID(), engineId, input.dockerContext, input.storageRoot, input.maxProjects);
    await privateJSON(join(bound.canonical, 'profile.initialization.json'), original); await syncHostDirectory(bound);
    const admission = await initializePreviewStorageAdmission({ root: input.storageRoot, engineId, runHost: input.runHost }, { maxProjects: input.maxProjects });
    await checkHostDirectory(bound); await mkdir(original.root, { mode: 0o700 }); await syncHostDirectory(bound);
    await initializePreviewHost({ root: original.root, engineId, run: input.run });
    const profile = { schema: 1, kind: 'fogd-preview-profile', id: original.id, directory: bound.canonical, root: original.root,
      engineId, dockerContext: original.dockerContext, storagePolicy: admission.policy };
    policyMatches(profile, await inspectPreviewStorageAdmission({ root: input.storageRoot, engineId, runHost: input.runHost }));
    await checkHostDirectory(bound); await privateJSON(join(bound.canonical, 'profile.json'), profile); await syncHostDirectory(bound);
    await privateJSON(join(bound.canonical, 'profile.complete.json'), profileCompletion(profile, original)); await syncHostDirectory(bound);
    return { schema: 1, kind: 'fogd-preview-profile-created', directory: bound.canonical, profileSha256: hash(jsonBytes(profile)),
      engineId, storagePolicyId: admission.policy.id, maxProjects: admission.policy.maxProjects, runtimeStarted: false, executionAuthorized: false };
  } catch { refusePreviewProfile(); }
}

export async function readPreviewProfile(directory, expectedProfileSha256) {
  const state = await readPreviewProfileState(directory, expectedProfileSha256);
  if (!state.complete) refusePreviewProfile();
  return state.profile;
}

// The caller owns this checking fence until release. Keeping it open allows
// metadata recovery to exclude allocation while observing an empty target.
export async function openBoundPreviewProfile(profile, { run, runHost }) {
  try {
    const host = await acquirePreviewHost(profile.root, profile.engineId);
    try {
      const observed = await readPreviewHost(run);
      if (previewProfileEngineId(observed) !== profile.engineId) refusePreviewProfile();
      assertRegisteredPreviewResources(observed, host.records);
      const storage = await inspectPreviewStorageAdmission({ root: profile.storagePolicy.root, engineId: profile.engineId, runHost });
      policyMatches(profile, storage);
      const status = { schema: 1, kind: 'fogd-preview-profile-status', id: profile.id, engineId: profile.engineId,
        historicalMemoryReservations: host.records.length, activeMemoryReservations: host.heldRecords.length,
        storagePolicyId: storage.policy.id, maxProjects: storage.policy.maxProjects, heldStorageProjects: storage.heldProjects,
        heldStorageChargeBytes: storage.heldChargeBytes, remainingStorageProjects: storage.remainingProjects, storageAdmissionOpen: storage.admissionOpen,
        resourcesRetained: true, executionAuthorized: false };
      return { profile, host, storage, status };
    } catch (error) { await host.fence.release(); throw error; }
  } catch { refusePreviewProfile(); }
}
export async function openPreviewProfile(input) {
  const profile = await readPreviewProfile(input.directory, input.expectedProfileSha256);
  return openBoundPreviewProfile(profile, input);
}
export async function inspectPreviewProfile(input) {
  try {
    const value = await openPreviewProfile(input);
    try { return value.status; }
    finally { await value.host.fence.release(); }
  } catch { refusePreviewProfile(); }
}
