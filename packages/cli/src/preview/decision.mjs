import { isDeepStrictEqual } from 'node:util';
import { controllerOrigin } from '../build-cache/paths.mjs';
import { serverOrigin } from '../local.mjs';
import { readAdminSnapshot } from '../inspect-command.mjs';
import { reviewSelection } from '../review/selection.mjs';
import { readPreviewInputs } from './inputs.mjs';
import { issuePreviewExecution } from './execution.mjs';
import { refuseExecution } from './execution-shape.mjs';

function currentSelection(state, inputs) {
  const selection = reviewSelection(state, inputs.preparation.source.submission);
  const expected = Object.fromEntries(Object.keys(selection.view).map(key => [key, inputs.review[key]]));
  if (!isDeepStrictEqual(selection.view, expected)) refuseExecution();
  return selection;
}

// Internal coordinator step only. Target freshness and runtime admission must
// already be checked independently. Never send credentials to a prepared URL.
export async function issueVerifiedPreviewExecution({ directory, expectedPreparationSha256, env, target, privateKey }) {
  try {
    const inputs = await readPreviewInputs(directory, expectedPreparationSha256);
    if (controllerOrigin(serverOrigin(env)) !== inputs.preparation.source.controller) refuseExecution();
    const before = currentSelection(await readAdminSnapshot(env), inputs);
    const after = currentSelection(await readAdminSnapshot(env), inputs);
    if (!isDeepStrictEqual(before.guard, after.guard)) refuseExecution();
    const envelope = issuePreviewExecution(inputs.preparation, { expectedPreparationSha256, release: inputs.release, target, privateKey });
    return { envelope, artifact: inputs.artifact, release: inputs.release };
  } catch { refuseExecution(); }
}
