const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const bytes = value => Number.isSafeInteger(value) && value >= 0;
const invalid = () => { throw new Error('Controller returned an invalid artifact prune report; private response contents are withheld'); };

function artifacts(value) {
  if (!Array.isArray(value) || !value.length) invalid();
  const rows = value.map(row => {
    if (!object(row) || !uuid(row.id) || !hash(row.digest) || !bytes(row.bytes)) invalid();
    return { id: row.id, digest: row.digest, bytes: row.bytes };
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length) invalid();
  return rows;
}
function identity(value) {
  if (!object(value) || !uuid(value.id) || !hash(value.plan)) invalid();
  return { id: value.id, plan: value.plan };
}
function total(rows, actual) {
  if (!bytes(actual) || rows.reduce((sum, row) => sum + row.bytes, 0) !== actual) invalid();
  return actual;
}
export function artifactPruneReceipt(value) {
  if (value?.schema !== 1) invalid();
  const base = identity(value), rows = artifacts(value.artifacts);
  return { schema: 1, ...base, artifacts: rows, reclaimedArtifactBytes: total(rows, value.reclaimedArtifactBytes) };
}
export function artifactPruneStatusView(value) {
  if (value?.schema !== 1) invalid();
  let operation = null;
  if (value.operation !== null) {
    const base = identity(value.operation), candidates = artifacts(value.operation.candidates);
    operation = { ...base, candidates, approvedArtifactBytes: total(candidates, value.operation.approvedArtifactBytes) };
  }
  return { schema: 1, operation, last: value.last === null ? null : artifactPruneReceipt(value.last) };
}
