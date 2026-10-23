import { validatePruneTargets } from './artifact-prune-manifest.mjs';

export const artifactPruneCapability = 'fogd-artifact-pruning-v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex64 = /^[0-9a-f]{64}$/;
const isId = value => typeof value === 'string' && uuid.test(value);
const isHash = value => typeof value === 'string' && hex64.test(value);
const terminal = new Set(['rejected', 'superseded']);
const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isMap(value) && Object.keys(value).sort().join() === keys;
const size = value => Number.isSafeInteger(value) && value >= 0;

function invalid() {
  const error = new Error('Controller artifact pruning metadata is malformed; restore a consistent state.json');
  error.code = 'ARTIFACT_PRUNING_INVALID';
  return error;
}

export function pendingPrune() {
  const error = new Error('An artifact prune operation is pending; resume it before other controller changes');
  error.code = 'ARTIFACT_PRUNE_PENDING';
  return error;
}

// Byte sum that refuses unsafe totals instead of rounding.
export function approvedBytes(rows) {
  const total = rows.reduce((sum, row) => sum + row.bytes, 0);
  if (!Number.isSafeInteger(total)) throw invalid();
  return total;
}

const pins = state => isMap(state.artifactPins?.releases) ? state.artifactPins.releases : {};

// A listed artifact must still name a terminal, unpinned deployment with the same digest.
function assertTerminal(state, { id, digest }) {
  if (!isId(id) || !isHash(digest)) throw invalid();
  const record = Object.hasOwn(state.deployments, id) ? state.deployments[id] : null;
  if (!isMap(record) || record.id !== id || record.digest !== digest || !terminal.has(record.status) || Object.hasOwn(pins(state), id)) throw invalid();
}

function validateMarker(state, id, marker) {
  if (!exactKeys(marker, 'bytes,operation,schema') || marker.schema !== 1 || !isId(marker.operation) || !size(marker.bytes)) throw invalid();
  assertTerminal(state, { id, digest: state.deployments[id].digest });
}

function validateOperation(state, operation) {
  if (!exactKeys(operation, 'candidates,id,plan') || !isId(operation.id) || !isHash(operation.plan)) throw invalid();
  try { validatePruneTargets(operation.candidates); } catch { throw invalid(); }
  approvedBytes(operation.candidates);
  for (const target of operation.candidates) {
    assertTerminal(state, target);
    if (Object.hasOwn(state.deployments[target.id], 'artifactPruned')) throw invalid();
  }
}

// The owner API omits file manifests. Validate its identity/byte summary against
// deployment history without treating it as authority to delete or resume files.
function validateOperationSummary(state, operation) {
  if (!exactKeys(operation, 'approvedArtifactBytes,candidates,id,plan') || !isId(operation.id) || !isHash(operation.plan)) throw invalid();
  const rows = operation.candidates;
  if (!Array.isArray(rows) || !rows.length || new Set(rows.map(row => row?.id)).size !== rows.length) throw invalid();
  for (const row of rows) {
    validateArtifactRow(state, row);
    if (Object.hasOwn(state.deployments[row.id], 'artifactPruned')) throw invalid();
  }
  if (approvedBytes(rows) !== operation.approvedArtifactBytes) throw invalid();
}

function validateReceipt(state, receipt) {
  if (!exactKeys(receipt, 'artifacts,id,plan,reclaimedArtifactBytes,schema') || receipt.schema !== 1 || !isId(receipt.id) || !isHash(receipt.plan)) throw invalid();
  const { artifacts } = receipt;
  if (!Array.isArray(artifacts) || !artifacts.length || new Set(artifacts.map(row => row?.id)).size !== artifacts.length) throw invalid();
  for (const row of artifacts) validateReceiptRow(state, receipt.id, row);
  if (approvedBytes(artifacts) !== receipt.reclaimedArtifactBytes) throw invalid();
}

function validateReceiptRow(state, operation, row) {
  validateArtifactRow(state, row);
  const marker = state.deployments[row.id].artifactPruned;
  if (marker?.operation !== operation || marker.bytes !== row.bytes) throw invalid();
}

function validateArtifactRow(state, row) {
  if (!exactKeys(row, 'bytes,digest,id') || !isId(row.id) || !size(row.bytes)) throw invalid();
  assertTerminal(state, row);
}

// Capability, field and per-deployment markers must agree; an older runtime refuses the capability.
function pruningPresence(state) {
  const present = Object.hasOwn(state, 'artifactPruning');
  const marked = Object.entries(isMap(state.deployments) ? state.deployments : {}).filter(([, record]) => isMap(record) && Object.hasOwn(record, 'artifactPruned'));
  const required = Array.isArray(state.requirements) && state.requirements.includes(artifactPruneCapability);
  if (required !== present || marked.length && !present) throw invalid();
  return { present, marked };
}

function validatePruningState(state, operationValidator) {
  if (!isMap(state)) throw invalid();
  const { present, marked } = pruningPresence(state);
  if (!present) return null;
  if (!isMap(state.deployments)) throw invalid();
  const pruning = state.artifactPruning;
  if (!exactKeys(pruning, 'last,operation,schema') || pruning.schema !== 1) throw invalid();
  for (const [id, record] of marked) validateMarker(state, id, record.artifactPruned);
  if (pruning.operation !== null) operationValidator(state, pruning.operation);
  if (pruning.last !== null) validateReceipt(state, pruning.last);
  if (pruning.operation && pruning.operation.id === pruning.last?.id) throw invalid();
  return pruning;
}

export const validateArtifactPruning = state => validatePruningState(state, validateOperation);
export const validateArtifactPruningSummary = state => validatePruningState(state, validateOperationSummary);

// Cheap guard for ordinary controller work; full validation runs at load and before pruning.
export function assertArtifactMutationAllowed(state) {
  if (isMap(state) && isMap(state.artifactPruning) && state.artifactPruning.operation != null) throw pendingPrune();
}

// Host snapshots refuse a pending operation before preparing or restoring anything.
export function assertArtifactSnapshotReady(state) {
  validateArtifactPruning(state);
  assertArtifactMutationAllowed(state);
}

// Public summary: identities and byte totals only, never file paths or hashes.
export function artifactPruneStatus(state) {
  const pruning = validateArtifactPruning(state);
  const operation = pruning?.operation;
  return {
    schema: 1,
    operation: operation ? { id: operation.id, plan: operation.plan, candidates: operation.candidates.map(({ id, digest, bytes }) => ({ id, digest, bytes })), approvedArtifactBytes: approvedBytes(operation.candidates) } : null,
    last: pruning?.last ? structuredClone(pruning.last) : null,
  };
}
