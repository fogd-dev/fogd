import { readdir } from 'node:fs/promises';
import { join, resolve, posix } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes, digest, uuid } from '../build-cache/paths.mjs';
import { bindHostDirectory } from '../runtime/host-directory.mjs';
import { readPrivatePreviewRecordSource } from './private-record.mjs';
import { executionKeys } from './execution-shape.mjs';
import { validatePreviewStoragePolicy } from './storage-admission.mjs';

export function refusePreviewProfile() {
  const error = new Error('Preview profile refused; retain its directory and host registry; do not repeat initialization');
  error.code = 'PREVIEW_PROFILE_REFUSED'; throw error;
}
export const profileInitialization = (directory, id, engineId, dockerContext, storageRoot, maxProjects) => ({ schema: 1, kind: 'fogd-preview-profile-initialization',
  id, directory, root: join(directory, 'ledger'), engineId, dockerContext, storageRoot, maxProjects });
export const profileCompletion = (profile, original) => ({ schema: 1, kind: 'fogd-preview-profile-completion', id: profile.id,
  profileSha256: hash(jsonBytes(profile)), initializationSha256: hash(jsonBytes(original)) });
export function validateProfileTarget(input) {
  if (typeof input.dockerContext !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.dockerContext) ||
    typeof input.storageRoot !== 'string' || !/^\/[A-Za-z0-9_./-]{1,200}$/.test(input.storageRoot) || input.storageRoot.endsWith('/') || posix.normalize(input.storageRoot) !== input.storageRoot ||
    !Number.isInteger(input.maxProjects) || input.maxProjects < 1 || input.maxProjects > 16) refusePreviewProfile();
}
export function previewProfileEngineId(observed) {
  const host = observed.host;
  if (typeof host.ID !== 'string' || !/^[^\x00-\x20\x7f]{1,256}$/.test(host.ID) || host.OSType !== 'linux' ||
    !['arm64', 'aarch64'].includes(host.Architecture) || host.Driver !== 'overlay2') refusePreviewProfile();
  return host.ID;
}
function profileFields(profile, bound) {
  executionKeys(profile, ['schema', 'kind', 'id', 'directory', 'root', 'engineId', 'dockerContext', 'storagePolicy']);
  if (profile.schema !== 1 || profile.kind !== 'fogd-preview-profile' || !uuid(profile.id) || typeof profile.engineId !== 'string' || !/^[^\x00-\x20\x7f]{1,256}$/.test(profile.engineId) || profile.directory !== bound.canonical || profile.root !== join(bound.canonical, 'ledger')) refusePreviewProfile();
  const policy = validatePreviewStoragePolicy(profile.storagePolicy, { root: profile.storagePolicy.root, engineId: profile.engineId });
  validateProfileTarget({ dockerContext: profile.dockerContext, storageRoot: policy.root, maxProjects: policy.maxProjects });
}
function members(names) {
  const base = ['ledger', 'profile.initialization.json', 'profile.json'];
  if (!isDeepStrictEqual(names, base) && !isDeepStrictEqual(names, [...base, 'profile.complete.json'].sort())) refusePreviewProfile();
  return names.includes('profile.complete.json');
}

// Partial state is only for explicit local completion. Normal profile consumers
// still require a verified completion record before reaching any transport.
export async function readPreviewProfileState(directory, expectedProfileSha256) {
  try {
    if (!digest(expectedProfileSha256)) refusePreviewProfile();
    const bound = await bindHostDirectory(resolve(directory)), complete = members((await readdir(bound.canonical)).sort());
    const profileSource = await readPrivatePreviewRecordSource(bound, 'profile.json', 16384, expectedProfileSha256), profile = profileSource.value;
    profileFields(profile, bound);
    if ((await bindHostDirectory(profile.root)).canonical !== profile.root) refusePreviewProfile();
    const originalSource = await readPrivatePreviewRecordSource(bound, 'profile.initialization.json', 16384), original = originalSource.value;
    if (!isDeepStrictEqual(original, profileInitialization(bound.canonical, profile.id, profile.engineId, profile.dockerContext, profile.storagePolicy.root, profile.storagePolicy.maxProjects))) refusePreviewProfile();
    const completionSource = complete ? await readPrivatePreviewRecordSource(bound, 'profile.complete.json', 16384) : null;
    if (completionSource && !isDeepStrictEqual(completionSource.value, profileCompletion(profile, original))) refusePreviewProfile();
    return { bound, profile, original, complete, sources: { profile: profileSource, initialization: originalSource, completion: completionSource } };
  } catch { refusePreviewProfile(); }
}
