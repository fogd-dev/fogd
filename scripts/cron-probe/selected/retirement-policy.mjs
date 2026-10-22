import assert from 'node:assert/strict';

const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');

export function expectedRetirementPolicy(source, networks, active, plan, retiredHistory = {}) {
  assert.match(plan.id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  assert.equal(plan.app, active.app); assert.equal(plan.digest, active.digest);
  const expected = structuredClone(source), fleet = expected.fleets.find(value => value.id === active.slot); assert.ok(fleet);
  assert.deepEqual(plan.previous, { slot: fleet.id, prefix: fleet.prefix, nodes: fleet.nodes.map(node => node.id) });
  const prefix = `retirement-generations/${plan.id}`, nodes = fleet.nodes.map(node => `${node.host}-${plan.id}`);
  const history = Object.values(retiredHistory); assert.ok(history.every(previous => previous.id !== plan.id));
  const prefixes = [...source.fleets.map(value => value.prefix), ...history.flatMap(value => [value.previous.prefix, value.replacement.prefix])];
  const occupied = new Set([...source.fleets.flatMap(value => value.nodes.map(node => node.id)), ...history.flatMap(value => [...value.previous.nodes, ...value.replacement.nodes])]);
  assert.ok(prefixes.every(previous => !overlaps(previous, prefix))); assert.ok(nodes.every(node => !occupied.has(node)));
  assert.deepEqual(plan.replacement, { prefix, nodes });
  expected.networks = structuredClone(networks); fleet.prefix = prefix;
  fleet.nodes.forEach((node, index) => { node.id = nodes[index]; });
  return expected;
}

export function assertUnassignedNamespace(objects, fleet) {
  assert.ok(Array.isArray(objects));
  const names = ['wake/format.json', 'wake/waker.json', 'fleet/capacity-v1.json', ...fleet.nodes.map(node => `nodes/${node.id}.json`)];
  const allowed = new Set(names.map(name => `${fleet.prefix}/${name}`));
  const keys = objects.map(row => { assert.ok(row && typeof row.key === 'string'); return row.key; });
  assert.equal(new Set(keys).size, keys.length); assert.ok(keys.every(key => allowed.has(key)), 'Unassigned fleet contains application or foreign metadata');
}
