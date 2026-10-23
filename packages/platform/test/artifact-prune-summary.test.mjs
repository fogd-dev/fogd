import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactPruneStatus, validateArtifactPruning, validateArtifactPruningSummary } from '../src/artifact-prune-state.mjs';
import { pruningState, prunedId } from './fixtures/artifact-pruning.mjs';

const input = { apps: {}, deployments: {} };
const invalid = { code: 'ARTIFACT_PRUNING_INVALID' };

test('the owner summary remains interpretable without becoming persisted deletion authority', () => {
  const full = pruningState(input, { pending: true }), summary = { ...full, artifactPruning: artifactPruneStatus(full) };
  assert.equal(validateArtifactPruningSummary(summary).operation.approvedArtifactBytes, 3);
  assert.throws(() => validateArtifactPruning(summary), invalid);
  assert.throws(() => validateArtifactPruningSummary(full), invalid);
});

test('completed pruning uses the same validated receipt and markers in disk and owner views', () => {
  const state = pruningState(input);
  assert.equal(validateArtifactPruningSummary(state).last.reclaimedArtifactBytes, 3);
  assert.equal(validateArtifactPruning(state).last.artifacts[0].id, prunedId);
});

for (const [name, change] of [
  ['wrong total', state => { state.artifactPruning.operation.approvedArtifactBytes++; }],
  ['unsafe total', state => { state.artifactPruning.operation.approvedArtifactBytes = Number.MAX_SAFE_INTEGER + 1; }],
  ['duplicate target', state => { state.artifactPruning.operation.candidates.push({ ...state.artifactPruning.operation.candidates[0] }); }],
  ['missing target', state => { delete state.deployments[prunedId]; }],
  ['changed digest', state => { state.deployments[prunedId].digest = 'f'.repeat(64); }],
  ['active target', state => { state.deployments[prunedId].status = 'active'; }],
  ['pinned target', state => { state.artifactPins = { schema: 1, releases: { [prunedId]: state.deployments[prunedId].digest } }; }],
  ['private manifest field', state => { state.artifactPruning.operation.candidates[0].files = []; }],
  ['coerced identity', state => { state.artifactPruning.operation.id = [state.artifactPruning.operation.id]; }],
  ['empty targets', state => { state.artifactPruning.operation.candidates = []; state.artifactPruning.operation.approvedArtifactBytes = 0; }],
  ['missing capability', state => { delete state.requirements; }],
]) test(`owner pruning summary refuses ${name}`, () => {
  const state = pruningState(input, { pending: true, summary: true }); change(state);
  assert.throws(() => validateArtifactPruningSummary(state), invalid);
});
