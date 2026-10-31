import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes, privateJSON, digest, exists } from '../build-cache/paths.mjs';
import { bindHostDirectory, checkHostDirectory, syncHostDirectory } from '../runtime/host-directory.mjs';
import { readStorageRequestState, checkedStorageRequestState } from './storage-request-state.mjs';
import { readPreviewSetup, previewSetupOutput } from './setup-inputs.mjs';
import { readPreviewInputs } from './inputs.mjs';
import { assertCurrentPreviewSource } from './decision.mjs';
import { validatePreviewRelease } from './execution.mjs';
import { preparePreviewStorage, inspectPreviewStorage } from './storage.mjs';
import { storageRequestInitialization, storageRequestCompletion, bindRequestStorage } from './storage-request-records.mjs';

function refuse() {
  const error = new Error('Preview storage request refused; retain its private directory and host records; do not repeat provisioning');
  error.code = 'PREVIEW_STORAGE_REQUEST_REFUSED'; throw error;
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
    const bound = await bindHostDirectory(output), original = storageRequestInitialization(output, setup);
    await privateJSON(join(output, 'storage.initialization.json'), original); await syncHostDirectory(bound);
    const request = { root: original.storageRoot, project: original.project, engineId: original.engineId, runHost: input.runHost };
    const storage = bindRequestStorage(original, await preparePreviewStorage(request));
    await checkHostDirectory(bound); await privateJSON(join(output, 'storage.json'), storage); await syncHostDirectory(bound);
    if (!isDeepStrictEqual(await inspectPreviewStorage(request, { phase: 'empty' }), storage)) refuse();
    const complete = storageRequestCompletion(original, storage);
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
    const state = await readStorageRequestState(bound);
    if (!state.storage || !state.completion || state.completion.sha256 !== expectedStorageRequestSha256) refuse();
    const { storage } = checkedStorageRequestState(bound, setup, state);
    return { directory: bound.canonical, storage };
  } catch { refuse(); }
}
