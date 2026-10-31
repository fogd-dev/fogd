import { join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest, hash, jsonBytes, privateJSON } from '../build-cache/paths.mjs';
import { bindHostDirectory, checkHostDirectory, syncHostDirectory } from '../runtime/host-directory.mjs';
import { readPreviewSetupIdentity } from './setup-inputs.mjs';
import { openPreviewProfile } from './profile.mjs';
import { inspectPreviewStorage } from './storage.mjs';
import { readStorageRequestState, checkedStorageRequestState } from './storage-request-state.mjs';
import { storageRecoveryReview, storageRecoveryRecord } from './storage-request-records.mjs';

function refuse() {
  const error = new Error('Preview storage setup recovery refused; retain local and host records');
  error.code = 'PREVIEW_STORAGE_SETUP_RECOVERY_REFUSED'; throw error;
}
async function open(input) {
  const setup = await readPreviewSetupIdentity(input), owner = await openPreviewProfile({ directory: setup.profile.directory,
    expectedProfileSha256: setup.profileSha256, run: input.run, runHost: input.runHost });
  try {
    const bound = await bindHostDirectory(resolve(input.storageDirectory)), state = await readStorageRequestState(bound);
    if ([setup.profile.directory, setup.directory].some(parent => bound.canonical === parent || bound.canonical.startsWith(parent + sep))) refuse();
    const project = 'fogd-preview-' + setup.preparation.id.replaceAll('-', '');
    if (owner.host.records.some(row => row.plan.project === project)) refuse();
    const actual = await inspectPreviewStorage({ root: setup.profile.storagePolicy.root, engineId: setup.profile.engineId, project, runHost: input.runHost }, { phase: 'empty' });
    const checked = checkedStorageRequestState(bound, setup, state, actual);
    const review = checked.recovery?.review ?? storageRecoveryReview(bound, checked.original, checked.storage, state);
    return { setup, owner, bound, state, ...checked, review };
  } catch (error) { await owner.host.fence.release(); throw error; }
}
function observation(value) {
  return { schema: 1, kind: 'fogd-preview-storage-setup-inspection', directory: value.bound.canonical, project: value.original.project,
    engineId: value.original.engineId, state: value.state.storage && value.state.completion ? 'complete' : value.recovery ? 'recovering' : 'incomplete',
    reviewSha256: hash(jsonBytes(value.review)), review: value.review,
    localReceiptPresent: Boolean(value.state.storage), localCompletionPresent: Boolean(value.state.completion),
    resourcesRetained: true, executionAuthorized: false };
}
export async function inspectPreviewStorageSetup(input) {
  try {
    const value = await open({ ...input });
    try { return observation(value); }
    finally { await value.owner.host.fence.release(); }
  } catch { refuse(); }
}
async function writeMissing(value, name, data) {
  await checkHostDirectory(value.bound); await privateJSON(join(value.bound.canonical, name), data); await syncHostDirectory(value.bound);
}

// Local completion only: the host must already be settled and physically empty.
// Keep the profile checking fence until publication ends. Never call prepare,
// reconcile a host operation, clear a host fence, reserve or release resources.
export async function reconcilePreviewStorageSetup(input) {
  try {
    input = { ...input };
    if (!digest(input.expectedReviewSha256)) refuse();
    const value = await open(input);
    try {
      if (hash(jsonBytes(value.review)) !== input.expectedReviewSha256) refuse();
      if (!isDeepStrictEqual(await readStorageRequestState(value.bound), value.state)) refuse();
      if ((!value.state.storage || !value.state.completion) && !value.recovery) await writeMissing(value, 'storage.recovery.json', storageRecoveryRecord(value.review));
      if (!value.state.storage) await writeMissing(value, 'storage.json', value.storage);
      if (!value.state.completion) await writeMissing(value, 'storage.complete.json', value.complete);
      const final = await readStorageRequestState(value.bound);
      checkedStorageRequestState(value.bound, value.setup, final, value.storage);
      return { schema: 1, kind: 'fogd-preview-storage-setup-reconciled', directory: value.bound.canonical, project: value.original.project,
        storageRequestSha256: hash(jsonBytes(value.complete)), reviewedSha256: input.expectedReviewSha256,
        resourcesRetained: true, storageChargeBytes: value.storage.storage.admission.chargeBytes,
        hostStorageActions: 'inspect-only', runtimeStarted: false, memoryReserved: false, executionAuthorized: false };
    } finally { await value.owner.host.fence.release(); }
  } catch { refuse(); }
}
