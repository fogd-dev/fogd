import assert from 'node:assert/strict';

const locations = { slot: 'slot-1', dir: '/var/lib/fogd', sourceRoot: '/var/lib/fogd/qualification/artifacts', output: '/var/lib/fogd/qualification/session' };
function pins(contract, artifacts) {
  assert.deepEqual(Object.keys(artifacts || {}).sort(), [...new Set(Object.entries(contract.releases).map(([name, release]) => release.artifact || name))].sort(), 'Unqualified release artifact names');
  assert.equal(new Set(Object.values(artifacts)).size, new Set(Object.entries(contract.releases).map(([name, release]) => release.artifact || name)).size, 'Unqualified duplicate release artifact');
}
export function releasePlan(contract, artifacts) {
  pins(contract, artifacts);
  return { ...locations, kind: contract.kind, artifacts: structuredClone(artifacts) };
}
function checkedPlan(policy, contract) {
  const plan = policy?.releases;
  if (policy?.schema !== 2 || !plan || plan.kind !== contract.kind) throw new Error('Unqualified release policy');
  for (const [key, value] of Object.entries(locations)) if (plan[key] !== value) throw new Error('Release location differs from its immutable contract');
  pins(contract, plan.artifacts);
  return plan;
}
export function selectedRelease(policy, contract, name, current = null) {
  const plan = checkedPlan(policy, contract);
  if (typeof name !== 'string' || !Object.hasOwn(contract.releases, name)) throw new Error('Unqualified release name');
  if ((current === null && name !== contract.initial) || (current !== null && (!Object.hasOwn(contract.releases, current) || contract.releases[current].next !== name))) throw new Error('Release order differs from its immutable contract');
  const artifact = contract.releases[name].artifact || name, digest = plan.artifacts[artifact];
  if (!Object.hasOwn(plan.artifacts, artifact) || typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Unqualified release artifact');
  return { ...locations, release: name, source: `${locations.sourceRoot}/${artifact}`, gate: contract.releases[name].gate, digest };
}
export function releaseCommand(policy, contract, current, command) {
  checkedPlan(policy, contract);
  if (!command || typeof command.id !== 'string' || !/^[a-f0-9-]{36}$/.test(command.id) || !['pause', 'resume', 'finish', 'update'].includes(command.operation)) throw new Error('Invalid release command');
  const allowed = command.operation === 'update' ? ['id', 'operation', 'release'] : ['id', 'operation'];
  if (Object.keys(command).some(key => !allowed.includes(key))) throw new Error('Release command cannot supply paths or gates');
  return command.operation === 'update' ? selectedRelease(policy, contract, command.release, current) : null;
}

export function activeRelease(policy, contract, state) {
  const plan = checkedPlan(policy, contract), active = state.apps.refresh.active;
  const approved = Object.values(state.deployments).filter(value => value.app === 'refresh' && value.step === 'complete' && ['active', 'superseded'].includes(value.status)).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  assert.ok(approved.length > 0 && approved.at(-1).id === active, 'Active release must be the latest completed approval');
  let name = contract.initial;
  for (const [index, request] of approved.entries()) {
    assert.ok(Object.hasOwn(contract.releases, name), 'Release approvals exceed the immutable sequence');
    const selected = contract.releases[name];
    assert.equal(request.digest, plan.artifacts[selected.artifact || name], 'Completed approval differs from the immutable release sequence');
    if (index) assert.ok(request.submittedAt > approved[index - 1].submittedAt, 'Release approval order is ambiguous');
    if (index < approved.length - 1) name = selected.next;
  }
  return name;
}
