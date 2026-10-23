import { artifactPruneStatus } from '../../src/artifact-prune-state.mjs';

export const prunedId = '00000000-0000-4000-8000-000000000009';
export const pruneId = '00000000-0000-4000-8000-000000000008';

// One old rejected release, independent of the caller's active/terminal records.
export function pruningState(input, { pending = false, summary = false, app = 'sample' } = {}) {
  const state = structuredClone(input), digest = 'b'.repeat(64), plan = 'd'.repeat(64);
  const row = { id: prunedId, digest, bytes: 3 };
  state.requirements = [...state.requirements || [], 'fogd-artifact-pruning-v1'];
  state.deployments[prunedId] = { id: prunedId, app, digest, status: 'rejected', step: 'submitted' };
  const operation = { id: pruneId, plan, candidates: [{ ...row, files: [{ path: 'private-artifact-path.js', bytes: 3, sha256: 'c'.repeat(64) }], directories: [] }] };
  const last = { schema: 1, id: pruneId, plan, artifacts: [row], reclaimedArtifactBytes: 3 };
  state.artifactPruning = { schema: 1, operation: pending ? operation : null, last: pending ? null : last };
  if (!pending) state.deployments[prunedId].artifactPruned = { schema: 1, operation: pruneId, bytes: 3 };
  if (summary) state.artifactPruning = artifactPruneStatus(state);
  return state;
}
