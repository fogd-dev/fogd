import { createHash } from 'node:crypto';
import { appName } from '@fogd/runtime/artifact';
import { artifactInventory } from './artifact-inventory.mjs';

const POLICY = 'fogd-terminal-artifact-retention-v1';
const REASONS = ['active', 'unfinished', 'retired', 'unknown-status', 'controller-reference', 'deployment-reference', 'unreferenced', 'digest-mismatch', 'invalid-deployment'];
const STATUS_REASONS = new Map([['active', 'active'], ['pending', 'unfinished'], ['failed', 'unfinished'], ['activating', 'unfinished'], ['retired', 'retired'], ['rejected', null], ['superseded', null], ['unknown', 'unknown-status']]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const hex64 = /^[0-9a-f]{64}$/;
const isMap = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ordered = reasons => REASONS.filter(reason => reasons.has(reason));

function safeApp(value) {
  try { return appName(value) === value; } catch { return false; }
}

function usableState(state) {
  if (!isMap(state) || !isMap(state.deployments) || !isMap(state.apps)) throw new Error('Controller metadata is not usable for artifact retention planning; restore a consistent state.json');
  return state;
}

// Every string value and object key below value; exact matches against ids are references.
function referencedStrings(value, found = new Set()) {
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') found.add(item);
    else if (item !== null && typeof item === 'object') for (const [key, child] of Object.entries(item)) { found.add(key); stack.push(child); }
  }
  return found;
}

function publicFields(id, record) {
  const known = isMap(record);
  return {
    id,
    app: known && safeApp(record.app) ? record.app : null,
    digest: known && typeof record.digest === 'string' && hex64.test(record.digest) ? record.digest : null,
    status: known && typeof record.status === 'string' && STATUS_REASONS.has(record.status) ? record.status : 'unknown',
  };
}

function describeRecord(id, record, row) {
  const fields = publicFields(id, record), reasons = new Set();
  const wellFormed = uuid.test(id) && record?.id === id && fields.app !== null && fields.digest !== null;
  if (!wellFormed) reasons.add('invalid-deployment');
  if (STATUS_REASONS.get(fields.status)) reasons.add(STATUS_REASONS.get(fields.status));
  if (row && (row.kind !== 'directory' || row.digest !== record?.digest)) reasons.add('digest-mismatch');
  return { fields, reasons, row };
}

// Retained records are roots; their references are followed transitively, excluding self ids.
function protectReferences(records, deployments, controllerReferences) {
  const queue = [...records.keys()].filter(id => records.get(id).reasons.size);
  const mark = (id, reason) => {
    const { reasons } = records.get(id);
    if (!reasons.size) queue.push(id);
    reasons.add(reason);
  };
  for (const id of controllerReferences) if (records.has(id)) mark(id, 'controller-reference');
  while (queue.length) {
    const id = queue.pop();
    for (const reference of referencedStrings(deployments[id])) if (reference !== id && records.has(reference)) mark(reference, 'deployment-reference');
  }
}

function decide(records, inventory, controllerReferences) {
  const candidates = [], kept = [], missing = [];
  for (const { fields, reasons, row } of records.values()) {
    if (!row) missing.push({ ...fields, reasons: ordered(reasons) });
    else if (reasons.size) kept.push({ ...fields, bytes: row.bytes, reasons: ordered(reasons) });
    else candidates.push({ ...fields, bytes: row.bytes });
  }
  for (const row of inventory) {
    if (records.has(row.id)) continue;
    const reasons = new Set(['unreferenced', ...controllerReferences.has(row.id) ? ['controller-reference'] : []]);
    kept.push({ id: row.id, app: null, digest: null, status: null, bytes: row.bytes, reasons: ordered(reasons) });
  }
  kept.sort((a, b) => a.id < b.id ? -1 : 1);
  return { candidates, protected: kept, missing };
}

// Read-only preview. The plan hash binds this view and every physical file hash; it is not a lease.
export async function planArtifactRetention(state, artifactDirectory) {
  const { deployments, ...metadata } = usableState(state);
  const inventory = await artifactInventory(artifactDirectory);
  const rows = new Map(inventory.map(row => [row.id, row]));
  const records = new Map(Object.keys(deployments).sort().map(id => [id, describeRecord(id, deployments[id], rows.get(id))]));
  const controllerReferences = referencedStrings(metadata);
  protectReferences(records, deployments, controllerReferences);
  const decision = decide(records, inventory, controllerReferences);
  const retainedArtifactBytes = inventory.reduce((sum, row) => sum + row.bytes, 0);
  if (!Number.isSafeInteger(retainedArtifactBytes)) throw new Error('Retained artifact bytes exceed safe accounting limits');
  const reclaimableArtifactBytes = decision.candidates.reduce((sum, row) => sum + row.bytes, 0);
  const view = { retainedArtifactBytes, reclaimableArtifactBytes, protectedArtifactBytes: retainedArtifactBytes - reclaimableArtifactBytes, ...decision };
  const plan = createHash('sha256').update(JSON.stringify([POLICY, view, inventory])).digest('hex');
  return { schema: 1, policy: POLICY, plan, ...view };
}
