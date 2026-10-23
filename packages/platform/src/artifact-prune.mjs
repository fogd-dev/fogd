import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { artifactInventory } from './artifact-inventory.mjs';
import { removeApprovedArtifacts } from './artifact-prune-files.mjs';
import { validatePruneTargets } from './artifact-prune-manifest.mjs';
import { artifactPruneCapability, approvedBytes, pendingPrune, validateArtifactPruning } from './artifact-prune-state.mjs';
import { artifactRetentionDecision } from './artifact-retention.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex64 = /^[0-9a-f]{64}$/;

function failure(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
const stale = () => failure('Artifact retention changed since review; plan artifact retention again', 'ARTIFACT_PRUNE_STALE');
const unknown = () => failure('Unknown artifact prune operation', 'ARTIFACT_PRUNE_UNKNOWN');
const refused = () => failure('Cannot prune retained artifacts; artifact contents no longer match the approved removal', 'ARTIFACT_PRUNE_REFUSED');

// Inventory rows carry `kind`; the persisted manifest holds only the approved identity and contents.
const target = ({ id, digest, bytes, files, directories }) => ({ id, digest, bytes, files, directories });

// Delete, re-account and record completion. Nothing touches the filesystem after the final save.
async function complete(controller, operation) {
  const root = join(controller.dir, 'artifacts');
  await removeApprovedArtifacts(root, operation.candidates);
  await controller.quota.init(root, controller.state.deployments);
  const artifacts = operation.candidates.map(({ id, digest, bytes }) => ({ id, digest, bytes }));
  const receipt = { schema: 1, id: operation.id, plan: operation.plan, artifacts, reclaimedArtifactBytes: approvedBytes(artifacts) };
  for (const { id, bytes } of artifacts) controller.state.deployments[id].artifactPruned = { schema: 1, operation: operation.id, bytes };
  controller.state.artifactPruning = { schema: 1, operation: null, last: receipt };
  await controller.save();
  return structuredClone(receipt);
}

// Starts a reviewed prune: the plan hash must match a fresh plan with at least one candidate.
export async function pruneArtifacts(controller, plan) {
  if (typeof plan !== 'string' || !hex64.test(plan)) throw new Error('Artifact pruning requires the reviewed retention plan hash');
  const pruning = validateArtifactPruning(controller.state);
  if (pruning?.operation) throw pendingPrune();
  if (pruning?.last?.plan === plan) return structuredClone(pruning.last);
  const inventory = await artifactInventory(join(controller.dir, 'artifacts'));
  const current = artifactRetentionDecision(controller.state, inventory);
  if (current.plan !== plan) throw stale();
  if (!current.candidates.length) throw failure('The reviewed plan has no reclaimable artifacts', 'ARTIFACT_PRUNE_EMPTY');
  const rows = new Map(inventory.map(row => [row.id, row]));
  const candidates = validatePruneTargets(current.candidates.map(row => target(rows.get(row.id))));
  const operation = { id: randomUUID(), plan, candidates };
  controller.state.requirements = [...new Set([...controller.state.requirements || [], artifactPruneCapability])];
  controller.state.artifactPruning = { schema: 1, operation, last: pruning?.last ?? null };
  await controller.save();
  return complete(controller, operation);
}

// Approved rows stand in for partially removed targets so leftovers cannot invent digest-mismatch
// roots; the remover then preflights what remains against those rows before any unlink.
function assertStillCandidates(state, inventory, operation) {
  const approved = new Map(operation.candidates.map(row => [row.id, { ...row, kind: 'directory' }]));
  const rows = [...inventory.filter(row => !approved.has(row.id)), ...approved.values()].sort((a, b) => a.id < b.id ? -1 : 1);
  const candidates = new Map(artifactRetentionDecision(state, rows).candidates.map(row => [row.id, row]));
  for (const row of operation.candidates) {
    const current = candidates.get(row.id);
    if (current?.digest !== row.digest || current.bytes !== row.bytes) throw refused();
  }
}

// Explicit resume only; reference protection is recomputed from current metadata before deleting.
export async function resumeArtifactPrune(controller, id) {
  if (typeof id !== 'string' || !uuid.test(id)) throw unknown();
  const pruning = validateArtifactPruning(controller.state);
  const operation = pruning?.operation;
  if (!operation) { if (pruning?.last?.id === id) return structuredClone(pruning.last); throw unknown(); }
  if (operation.id !== id) throw unknown();
  assertStillCandidates(controller.state, await artifactInventory(join(controller.dir, 'artifacts')), operation);
  return complete(controller, operation);
}
