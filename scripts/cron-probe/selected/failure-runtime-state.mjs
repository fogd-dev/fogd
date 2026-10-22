import assert from 'node:assert/strict';

const counters = ['quiescing', 'evicting', 'releasing', 'adopting', 'restoring'];
export function replicasQuiescent(replicas) {
  assert.equal(replicas.length, 2); assert.equal(new Set(replicas.map(row => row.node)).size, 2);
  if (replicas.some(row => row.error)) return false;
  for (const row of replicas) for (const name of counters) assert.ok(Number.isSafeInteger(row.state[name]) && row.state[name] >= 0, 'Native activity counter is invalid');
  return replicas.every(row => counters.every(name => row.state[name] === 0));
}
export function assertResidentCron(replicas, owner, version) {
  const owners = replicas.filter(row => row.node === owner); assert.equal(owners.length, 1);
  for (const row of replicas) {
    const state = row.state, deployment = state.deployment;
    assert.equal(deployment.version, version); assert.equal(deployment.swapping, 0);
    assert.ok(Number.isSafeInteger(deployment.generation) && deployment.generation >= 0);
    assert.ok(Array.isArray(state.residents));
    assert.equal(state.residents.includes('.cron:refresh'), row.node === owner, 'Cron residency does not match the persisted owner');
  }
  const deployment = owners[0].state.deployment;
  assert.equal(deployment.cells['.cron:refresh'], deployment.generation);
}
export function assertPreparedRuntime(snapshot, owner, epoch, version) {
  assert.deepEqual(snapshot.bucket.owner, { node: owner, epoch }, 'Paused cron ownership changed before resume');
  assert.equal(replicasQuiescent(snapshot.replicas), true, 'Native handoff or restoration is still in flight');
  assertResidentCron(snapshot.replicas, owner, version);
}
