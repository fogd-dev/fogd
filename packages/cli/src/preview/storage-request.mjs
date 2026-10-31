import { mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes, privateJSON, digest, exists } from '../build-cache/paths.mjs';
import { bindHostDirectory, checkHostDirectory, syncHostDirectory } from '../runtime/host-directory.mjs';
import { readPrivatePreviewRecord } from './private-record.mjs';
import { readPreviewSetup, previewSetupOutput } from './setup-inputs.mjs';
import { readPreviewInputs } from './inputs.mjs';
import { assertCurrentPreviewSource } from './decision.mjs';
import { validatePreviewRelease } from './execution.mjs';
import { preparePreviewStorage, inspectPreviewStorage, validatePreviewStorageReceipt, previewStorageWorkerSha256 } from './storage.mjs';

function refuse() {
  const error = new Error('Preview storage request refused; retain its private directory and host records; do not repeat provisioning');
  error.code = 'PREVIEW_STORAGE_REQUEST_REFUSED'; throw error;
}
function initialization(directory, setup) {
  const { profile, preparation } = setup;
  return { schema: 1, kind: 'fogd-preview-storage-request-initialization', directory,
    profileDirectory: profile.directory, profileSha256: setup.profileSha256, preparationDirectory: setup.directory,
    preparationSha256: setup.preparationSha256, runtime: preparation.runtime, engineId: profile.engineId,
    project: 'fogd-preview-' + preparation.id.replaceAll('-', ''), storageRoot: profile.storagePolicy.root, storagePolicyId: profile.storagePolicy.id, storageRootIdentity: profile.storagePolicy.rootIdentity };
}
function completion(original, storage) {
  return { schema: 1, kind: 'fogd-preview-storage-request-completion', initializationSha256: hash(jsonBytes(original)), storageSha256: hash(jsonBytes(storage)) };
}
function bindStorage(original, input) {
  const receipt = validatePreviewStorageReceipt(input, { project: original.project, engineId: original.engineId });
  if (receipt.workerSha256 !== previewStorageWorkerSha256 || receipt.storage.admission.profileId !== original.storagePolicyId ||
    !isDeepStrictEqual(receipt.storage.rootIdentity, original.storageRootIdentity) || receipt.storage.mount.target !== original.storageRoot + '/' + original.project + '/mount') refuse();
  return receipt;
}

// Allocate storage only. The host's canonical budget/fence owns uncertain
// effects; a local intent precedes them and an existing output never replays them.
export async function preparePreviewStorageRequest(input) {
  try {
    input = { ...input, env: { ...input.env } };
    if (typeof input.output !== 'string' || !input.output || await exists(resolve(input.output))) refuse();
    const setup = await readPreviewSetup(input), output = await previewSetupOutput(setup, input.output);
    if (!setup.status.storageAdmissionOpen) refuse();
    const inputs = await readPreviewInputs(setup.directory, setup.preparationSha256);
    validatePreviewRelease(inputs.preparation, inputs.release);
    await assertCurrentPreviewSource(inputs, input.env);
    const parent = await bindHostDirectory(dirname(output)); await checkHostDirectory(parent);
    await mkdir(output, { mode: 0o700 }); await syncHostDirectory(parent);
    const bound = await bindHostDirectory(output), original = initialization(output, setup);
    await privateJSON(join(output, 'storage.initialization.json'), original); await syncHostDirectory(bound);
    const request = { root: original.storageRoot, project: original.project, engineId: original.engineId, runHost: input.runHost };
    const storage = bindStorage(original, await preparePreviewStorage(request));
    await checkHostDirectory(bound); await privateJSON(join(output, 'storage.json'), storage); await syncHostDirectory(bound);
    if (!isDeepStrictEqual(await inspectPreviewStorage(request, { phase: 'empty' }), storage)) refuse();
    const complete = completion(original, storage);
    await checkHostDirectory(bound); await privateJSON(join(output, 'storage.complete.json'), complete); await syncHostDirectory(bound);
    return { schema: 1, kind: 'fogd-preview-storage-request-created', directory: output, storageRequestSha256: hash(jsonBytes(complete)),
      project: original.project, engineId: original.engineId, chargeBytes: storage.storage.admission.chargeBytes,
      resourcesRetained: true, runtimeStarted: false, memoryReserved: false, executionAuthorized: false };
  } catch { refuse(); }
}

// The original completion fingerprint binds both storage bytes and the exact
// preparation/profile intent. A receipt alone cannot authorize a different app.
export async function readPreviewStorageRequest(directory, expectedStorageRequestSha256, setup) {
  try {
    if (!digest(expectedStorageRequestSha256)) refuse();
    const bound = await bindHostDirectory(resolve(directory));
    if (!isDeepStrictEqual((await readdir(bound.canonical)).sort(), ['storage.complete.json', 'storage.initialization.json', 'storage.json'])) refuse();
    const complete = await readPrivatePreviewRecord(bound, 'storage.complete.json', 16384, expectedStorageRequestSha256);
    const original = await readPrivatePreviewRecord(bound, 'storage.initialization.json', 16384);
    if (!isDeepStrictEqual(original, initialization(bound.canonical, setup))) refuse();
    const storage = bindStorage(original, await readPrivatePreviewRecord(bound, 'storage.json', 65536));
    if (!isDeepStrictEqual(complete, completion(original, storage))) refuse();
    return { directory: bound.canonical, storage };
  } catch { refuse(); }
}
