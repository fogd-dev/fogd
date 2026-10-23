const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const app = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
const bytes = value => Number.isSafeInteger(value) && value >= 0;
const statuses = new Set(['active', 'pending', 'failed', 'activating', 'rejected', 'superseded', 'retired', 'unknown']);
const reasons = new Set(['active', 'unfinished', 'retired', 'unknown-status', 'controller-reference', 'deployment-reference', 'unreferenced', 'digest-mismatch', 'invalid-deployment', 'operator-pin', 'pruned']);
const invalid = () => { throw new Error('Controller returned an invalid artifact retention plan; private response contents are withheld'); };

function identity(row) {
  if (!object(row)) invalid();
  if (typeof row.id !== 'string' || !row.id.length || row.id.length > 255) invalid();
  if (row.app !== null && !app(row.app)) invalid();
  if (row.digest !== null && !hash(row.digest)) invalid();
  if (row.status !== null && !statuses.has(row.status)) invalid();
  return { id: row.id, app: row.app, digest: row.digest, status: row.status };
}
function candidate(row) {
  const result = identity(row);
  if (!uuid(row.id) || !app(row.app) || !hash(row.digest)) invalid();
  if (!['rejected', 'superseded'].includes(row.status) || !bytes(row.bytes)) invalid();
  return { ...result, bytes: row.bytes };
}
function retained(row, includeBytes) {
  const result = identity(row);
  if (!Array.isArray(row.reasons) || (includeBytes && !row.reasons.length) || !row.reasons.every(reason => reasons.has(reason))) invalid();
  if (includeBytes && !bytes(row.bytes)) invalid();
  return { ...result, ...(includeBytes ? { bytes: row.bytes } : {}), reasons: [...row.reasons] };
}
function totals(plan, candidates, protectedRows) {
  const names = ['retainedArtifactBytes', 'reclaimableArtifactBytes', 'protectedArtifactBytes'];
  if (!names.every(name => bytes(plan[name]))) invalid();
  const reclaimable = candidates.reduce((sum, row) => sum + row.bytes, 0);
  const protectedBytes = protectedRows.reduce((sum, row) => sum + row.bytes, 0);
  if (reclaimable !== plan.reclaimableArtifactBytes || protectedBytes !== plan.protectedArtifactBytes || reclaimable + protectedBytes !== plan.retainedArtifactBytes) invalid();
  return Object.fromEntries(names.map(name => [name, plan[name]]));
}

export function artifactRetentionView(plan) {
  if (!object(plan) || plan.schema !== 1 || plan.policy !== 'fogd-terminal-artifact-retention-v1' || !hash(plan.plan)) invalid();
  if (![plan.candidates, plan.protected, plan.missing].every(Array.isArray)) invalid();
  const candidates = plan.candidates.map(candidate), protectedRows = plan.protected.map(row => retained(row, true));
  return { schema: 1, policy: plan.policy, plan: plan.plan, ...totals(plan, candidates, protectedRows), candidates,
    protected: protectedRows, missing: plan.missing.map(row => retained(row, false)) };
}
