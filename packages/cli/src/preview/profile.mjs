import { mkdir, readdir } from 'node:fs/promises';
import { dirname, basename, join, resolve, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes, privateJSON, digest, uuid, exists } from '../build-cache/paths.mjs';
import { bindHostDirectory, checkHostDirectory, syncHostDirectory } from '../runtime/host-directory.mjs';
import { readPrivatePreviewRecord } from './private-record.mjs';
import { executionKeys } from './execution-shape.mjs';
import { readPreviewHost } from './host-inventory.mjs';
import { initializePreviewHost } from './host-reservations.mjs';
import { acquirePreviewHost } from './host-registry.mjs';
import { assertRegisteredPreviewResources } from './host-records.mjs';
import { initializePreviewStorageAdmission, inspectPreviewStorageAdmission, validatePreviewStoragePolicy } from './storage-admission.mjs';

function refuse() {
  const error = new Error('Preview profile refused; retain its directory and host registry; do not repeat initialization');
  error.code = 'PREVIEW_PROFILE_REFUSED'; throw error;
}
const intent = (directory, id, engineId, dockerContext, storageRoot, maxProjects) => ({ schema: 1, kind: 'fogd-preview-profile-initialization',
  id, directory, root: join(directory, 'ledger'), engineId, dockerContext, storageRoot, maxProjects });
const completion = (profile, original) => ({ schema: 1, kind: 'fogd-preview-profile-completion', id: profile.id,
  profileSha256: hash(jsonBytes(profile)), initializationSha256: hash(jsonBytes(original)) });
function target(input) {
  if (typeof input.dockerContext !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.dockerContext) ||
    typeof input.storageRoot !== 'string' || !/^\/[A-Za-z0-9_./-]{1,200}$/.test(input.storageRoot) || input.storageRoot.endsWith('/') || posix.normalize(input.storageRoot) !== input.storageRoot ||
    !Number.isInteger(input.maxProjects) || input.maxProjects < 1 || input.maxProjects > 16) refuse();
}
function engine(observed) {
  const host = observed.host;
  if (typeof host.ID !== 'string' || !/^[^\x00-\x20\x7f]{1,256}$/.test(host.ID) || host.OSType !== 'linux' ||
    !['arm64', 'aarch64'].includes(host.Architecture) || host.Driver !== 'overlay2') refuse();
  return host.ID;
}
async function freshOutput(output) {
  if (typeof output !== 'string' || !output) refuse();
  const parent = await bindHostDirectory(dirname(resolve(output))), directory = join(parent.canonical, basename(resolve(output)));
  if (await exists(directory)) refuse();
  return { parent, directory };
}
function policyMatches(profile, admission) {
  if (!isDeepStrictEqual(profile.storagePolicy, admission.policy) || admission.pending) refuse();
}

// Fresh setup only. Intent is durable before host effects. Any later failure
// retains the initialized policy, partial ledger and original local directory.
export async function initializePreviewProfile(input) {
  try {
    input = { ...input }; target(input);
    if (typeof input.run !== 'function' || typeof input.runHost !== 'function') refuse();
    const output = await freshOutput(input.output), observed = await readPreviewHost(input.run), engineId = engine(observed);
    assertRegisteredPreviewResources(observed, []);
    await checkHostDirectory(output.parent); await mkdir(output.directory, { mode: 0o700 }); await syncHostDirectory(output.parent);
    const bound = await bindHostDirectory(output.directory), original = intent(bound.canonical, randomUUID(), engineId, input.dockerContext, input.storageRoot, input.maxProjects);
    await privateJSON(join(bound.canonical, 'profile.initialization.json'), original); await syncHostDirectory(bound);
    const admission = await initializePreviewStorageAdmission({ root: input.storageRoot, engineId, runHost: input.runHost }, { maxProjects: input.maxProjects });
    await checkHostDirectory(bound); await mkdir(original.root, { mode: 0o700 }); await syncHostDirectory(bound);
    await initializePreviewHost({ root: original.root, engineId, run: input.run });
    const profile = { schema: 1, kind: 'fogd-preview-profile', id: original.id, directory: bound.canonical, root: original.root,
      engineId, dockerContext: original.dockerContext, storagePolicy: admission.policy };
    policyMatches(profile, await inspectPreviewStorageAdmission({ root: input.storageRoot, engineId, runHost: input.runHost }));
    await checkHostDirectory(bound); await privateJSON(join(bound.canonical, 'profile.json'), profile); await syncHostDirectory(bound);
    await privateJSON(join(bound.canonical, 'profile.complete.json'), completion(profile, original)); await syncHostDirectory(bound);
    return { schema: 1, kind: 'fogd-preview-profile-created', directory: bound.canonical, profileSha256: hash(jsonBytes(profile)),
      engineId, storagePolicyId: admission.policy.id, maxProjects: admission.policy.maxProjects, runtimeStarted: false, executionAuthorized: false };
  } catch { refuse(); }
}

export async function readPreviewProfile(directory, expectedProfileSha256) {
  try {
    if (!digest(expectedProfileSha256)) refuse();
    const bound = await bindHostDirectory(resolve(directory));
    if (!isDeepStrictEqual((await readdir(bound.canonical)).sort(), ['ledger', 'profile.complete.json', 'profile.initialization.json', 'profile.json'])) refuse();
    const profile = await readPrivatePreviewRecord(bound, 'profile.json', 16384, expectedProfileSha256);
    executionKeys(profile, ['schema', 'kind', 'id', 'directory', 'root', 'engineId', 'dockerContext', 'storagePolicy']);
    if (profile.schema !== 1 || profile.kind !== 'fogd-preview-profile' || !uuid(profile.id) || typeof profile.engineId !== 'string' || !/^[^\x00-\x20\x7f]{1,256}$/.test(profile.engineId) || profile.directory !== bound.canonical || profile.root !== join(bound.canonical, 'ledger')) refuse();
    const policy = validatePreviewStoragePolicy(profile.storagePolicy, { root: profile.storagePolicy.root, engineId: profile.engineId });
    target({ dockerContext: profile.dockerContext, storageRoot: policy.root, maxProjects: policy.maxProjects });
    if ((await bindHostDirectory(profile.root)).canonical !== profile.root) refuse();
    const original = await readPrivatePreviewRecord(bound, 'profile.initialization.json', 16384);
    if (!isDeepStrictEqual(original, intent(bound.canonical, profile.id, profile.engineId, profile.dockerContext, policy.root, policy.maxProjects))) refuse();
    const complete = await readPrivatePreviewRecord(bound, 'profile.complete.json', 16384);
    if (!isDeepStrictEqual(complete, completion(profile, original))) refuse();
    return profile;
  } catch { refuse(); }
}

export async function inspectPreviewProfile({ directory, expectedProfileSha256, run, runHost }) {
  try {
    const profile = await readPreviewProfile(directory, expectedProfileSha256), host = await acquirePreviewHost(profile.root, profile.engineId);
    try {
      const observed = await readPreviewHost(run);
      if (engine(observed) !== profile.engineId) refuse();
      assertRegisteredPreviewResources(observed, host.records);
      const storage = await inspectPreviewStorageAdmission({ root: profile.storagePolicy.root, engineId: profile.engineId, runHost });
      policyMatches(profile, storage);
      return { schema: 1, kind: 'fogd-preview-profile-status', id: profile.id, engineId: profile.engineId,
        historicalMemoryReservations: host.records.length, activeMemoryReservations: host.heldRecords.length,
        storagePolicyId: storage.policy.id, maxProjects: storage.policy.maxProjects, heldStorageProjects: storage.heldProjects,
        heldStorageChargeBytes: storage.heldChargeBytes, remainingStorageProjects: storage.remainingProjects, storageAdmissionOpen: storage.admissionOpen,
        resourcesRetained: true, executionAuthorized: false };
    } finally { await host.fence.release(); }
  } catch { refuse(); }
}
