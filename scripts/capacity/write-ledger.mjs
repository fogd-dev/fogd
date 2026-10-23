export function reconcileWrites(attempts, rows) {
  if (!Array.isArray(attempts) || !attempts.length || !Array.isArray(rows)) throw new Error('Missing write ledger evidence');
  const expected = attemptedWrites(attempts), committed = committedWrites(rows, expected);
  const acknowledgedMissing = [], unacknowledgedCommitted = [], unacknowledgedAbsent = [];
  let acknowledged = 0;
  for (const [id, sample] of expected) {
    if (sample.status === 200 && sample.correct) { acknowledged++; if (!committed.has(id)) acknowledgedMissing.push(id); }
    else (committed.has(id) ? unacknowledgedCommitted : unacknowledgedAbsent).push({ writeId: id, status: sample.status });
  }
  return { attempts: expected.size, committed: committed.size, acknowledged, acknowledgedMissing: acknowledgedMissing.sort(),
    unacknowledgedCommitted: byId(unacknowledgedCommitted), unacknowledgedAbsent: byId(unacknowledgedAbsent) };
}

function attemptedWrites(attempts) {
  const expected = new Map();
  for (const sample of attempts) {
    if (!sample || typeof sample.writeId !== 'string' || !/^[a-z0-9-]{1,96}$/.test(sample.writeId) || expected.has(sample.writeId)) throw new Error('Invalid or duplicate write attempt');
    if (!Number.isInteger(sample.status) || sample.status < 0 || sample.status > 599 || typeof sample.correct !== 'boolean') throw new Error('Invalid write response');
    expected.set(sample.writeId, sample);
  }
  return expected;
}
function committedWrites(rows, expected) {
  const committed = new Set();
  for (const row of rows) {
    if (!row || row.app !== 'baseline' || !expected.has(row.id) || committed.has(row.id)) throw new Error('Unexpected or duplicate committed write');
    committed.add(row.id);
  }
  return committed;
}

function byId(rows) { return rows.sort((a, b) => a.writeId.localeCompare(b.writeId)); }
