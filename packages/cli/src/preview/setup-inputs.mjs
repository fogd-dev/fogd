import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes } from '../build-cache/paths.mjs';
import { bindHostDirectory } from '../runtime/host-directory.mjs';
import { readPreviewPreparation } from './inputs.mjs';
import { previewRuntimeFamily } from './runtime-catalog.mjs';
import { readPreviewProfile, inspectPreviewProfile } from './profile.mjs';
import { checkPreviewOwnerControlLocation } from './owner-control.mjs';

// Runtime admission precedes source/host observations. The preparation selects
// the runtime; neither settings nor stored receipt files can enable a candidate.
export async function readPreviewSetup(input) {
  if (typeof input.run !== 'function' || typeof input.runHost !== 'function') throw new Error('Preview setup transports refused');
  const directory = (await bindHostDirectory(input.directory)).canonical;
  const { preparation } = await readPreviewPreparation(directory, input.expectedPreparationSha256);
  const runtime = previewRuntimeFamily(preparation.runtime.family, { candidateEnrollment: input.candidateEnrollment });
  if (!isDeepStrictEqual(preparation.runtime, { family: runtime.id, catalogEntrySha256: hash(jsonBytes(runtime)) })) throw new Error('Preview preparation runtime refused');
  const profile = await readPreviewProfile(input.profileDirectory, input.expectedProfileSha256);
  const status = await inspectPreviewProfile({ directory: profile.directory, expectedProfileSha256: input.expectedProfileSha256, run: input.run, runHost: input.runHost });
  return { directory, preparation, runtime, profile, status, preparationSha256: input.expectedPreparationSha256, profileSha256: input.expectedProfileSha256 };
}
export function previewSetupOutput(setup, output) {
  return checkPreviewOwnerControlLocation({ root: setup.profile.directory, directory: setup.directory }, { directory: output, dockerContext: setup.profile.dockerContext });
}
