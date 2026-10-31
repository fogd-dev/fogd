import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { hash, privateJSON } from '../build-cache/paths.mjs';
import { checkHostDirectory, syncHostDirectory } from '../runtime/host-directory.mjs';
import { openBoundPreviewProfile } from './profile.mjs';
import { refusePreviewProfile, profileCompletion, readPreviewProfileState } from './profile-records.mjs';

async function unusedTarget(value) {
  await checkHostDirectory(value.host.allocations);
  if (value.host.records.length || value.storage.heldProjects || (await readdir(value.host.allocations.canonical)).length ||
    !isDeepStrictEqual(await readdir(value.profile.root), [hash(value.profile.engineId)])) refusePreviewProfile();
  await checkHostDirectory(value.host.allocations);
}

// Finish only the final local record for an already initialized, unused target.
// Never initialize or repair a ledger, provision storage, or clear pending work.
export async function completePreviewProfile(input) {
  try {
    input = { ...input };
    const state = await readPreviewProfileState(input.directory, input.expectedProfileSha256);
    const value = await openBoundPreviewProfile(state.profile, input);
    try {
      await unusedTarget(value);
      if (!isDeepStrictEqual(await readPreviewProfileState(input.directory, input.expectedProfileSha256), state)) refusePreviewProfile();
      if (!state.complete) {
        await checkHostDirectory(state.bound);
        await privateJSON(join(state.bound.canonical, 'profile.complete.json'), profileCompletion(state.profile, state.original));
        await syncHostDirectory(state.bound);
      }
      const final = await readPreviewProfileState(input.directory, input.expectedProfileSha256);
      if (!final.complete || !isDeepStrictEqual(final.bound, state.bound) ||
        !isDeepStrictEqual(final.sources.profile, state.sources.profile) ||
        !isDeepStrictEqual(final.sources.initialization, state.sources.initialization)) refusePreviewProfile();
      const { profile } = final;
      return { schema: 1, kind: 'fogd-preview-profile-completed', directory: profile.directory,
        profileSha256: input.expectedProfileSha256, engineId: profile.engineId, storagePolicyId: profile.storagePolicy.id,
        completionWritten: !state.complete, hostStorageActions: 'inspect-only', resourcesRetained: true,
        runtimeStarted: false, memoryReserved: false, executionAuthorized: false };
    } finally { await value.host.fence.release(); }
  } catch { refusePreviewProfile(); }
}
