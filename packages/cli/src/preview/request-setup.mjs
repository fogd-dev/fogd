import { resolve } from 'node:path';
import { exists } from '../build-cache/paths.mjs';
import { readPreviewSetup, previewSetupOutput } from './setup-inputs.mjs';
import { readPreviewStorageRequest } from './storage-request.mjs';
import { createPreviewLaunchRequest } from './launch-request.mjs';
import { checkPreviewOwnerControlLocation } from './owner-control.mjs';
import { executionKeys } from './execution-shape.mjs';

export async function createProfilePreviewRequest(input) {
  try {
    input = { ...input, env: { ...input.env }, settings: structuredClone(input.settings) };
    if (typeof input.output !== 'string' || !input.output || await exists(resolve(input.output))) throw new Error('Existing request output');
    const setup = await readPreviewSetup(input), receipt = await readPreviewStorageRequest(input.storageDirectory, input.expectedStorageRequestSha256, setup);
    executionKeys(input.settings, ['origin', 'subnets', 'tls', 'secrets']);
    const output = await previewSetupOutput(setup, input.output);
    await checkPreviewOwnerControlLocation({ root: receipt.directory, directory: setup.directory }, { directory: output, dockerContext: setup.profile.dockerContext });
    return await createPreviewLaunchRequest({ root: setup.profile.root, directory: setup.directory, expectedPreparationSha256: setup.preparationSha256,
      runtime: setup.runtime.id, candidateEnrollment: input.candidateEnrollment, engineId: setup.profile.engineId,
      storage: receipt.storage, dockerContext: setup.profile.dockerContext, ...input.settings, output, env: input.env, runStorageHost: input.runHost });
  } catch {
    const error = new Error('Preview request setup refused; retain its inputs and original fingerprints');
    error.code = 'PREVIEW_REQUEST_SETUP_REFUSED'; throw error;
  }
}
