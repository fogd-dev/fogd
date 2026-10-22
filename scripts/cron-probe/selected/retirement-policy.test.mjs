import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedRetirementPolicy, assertUnassignedNamespace } from './retirement-policy.mjs';

function fixture() {
  return {
    source: { family: 'frozen-candidate', binarySha256: 'checked-binary', storage: { endpoint: 'http://minio:9000', region: 'us-east-1' }, networks: { control: 'old-network' },
      fleets: [{ id: '1', prefix: 'slot-1', nodes: [{ id: 'old-a', host: 'slot-1-a' }, { id: 'old-b', host: 'slot-1-b' }] }, { id: '2', prefix: 'slot-2', nodes: [{ id: 'survivor-a', host: 'slot-2-a' }, { id: 'survivor-b', host: 'slot-2-b' }] }] },
    networks: { control: 'new-network' }, active: { app: 'retired-app', digest: 'approved-digest', slot: '1' },
    plan: { id: '11111111-1111-4111-8111-111111111111', app: 'retired-app', digest: 'approved-digest', previous: { slot: '1', prefix: 'slot-1', nodes: ['old-a', 'old-b'] },
      replacement: { prefix: 'retirement-generations/11111111-1111-4111-8111-111111111111', nodes: ['slot-1-a-11111111-1111-4111-8111-111111111111', 'slot-1-b-11111111-1111-4111-8111-111111111111'] } },
  };
}
test('retirement expectation changes only the selected fleet and authorized networks', () => {
  const { source, networks, active, plan } = fixture();
  assert.deepEqual(expectedRetirementPolicy(source, networks, active, plan), {
    family: 'frozen-candidate', binarySha256: 'checked-binary', storage: { endpoint: 'http://minio:9000', region: 'us-east-1' }, networks: { control: 'new-network' },
    fleets: [{ id: '1', prefix: 'retirement-generations/11111111-1111-4111-8111-111111111111', nodes: [{ id: 'slot-1-a-11111111-1111-4111-8111-111111111111', host: 'slot-1-a' }, { id: 'slot-1-b-11111111-1111-4111-8111-111111111111', host: 'slot-1-b' }] },
      { id: '2', prefix: 'slot-2', nodes: [{ id: 'survivor-a', host: 'slot-2-a' }, { id: 'survivor-b', host: 'slot-2-b' }] }],
  });
});
for (const [name, alter] of [
  ['another app', value => { value.plan.app = 'survivor'; }],
  ['another digest', value => { value.plan.digest = 'unapproved'; }],
  ['another assigned fleet', value => { value.active.slot = '2'; }],
  ['an unknown fleet', value => { value.active.slot = 'missing'; }],
  ['a changed retained prefix', value => { value.plan.previous.prefix = 'slot-2'; }],
  ['a changed retained node', value => { value.plan.previous.nodes[0] = 'survivor-a'; }],
  ['an arbitrary replacement prefix', value => { value.plan.replacement.prefix = 'slot-2'; }],
  ['an arbitrary replacement node', value => { value.plan.replacement.nodes[0] = 'survivor-a'; }],
  ['a malformed generation', value => { value.plan.id = 'invalid'; }],
  ['a generation made only of separators', value => { value.plan.id = '------------------------------------'; }],
]) test(`retirement expectation refuses ${name}`, () => {
  const value = fixture(); alter(value); assert.throws(() => expectedRetirementPolicy(value.source, value.networks, value.active, value.plan), { code: 'ERR_ASSERTION' });
});
test('retirement expectation leaves its independently recorded source policy unchanged', () => {
  const { source, networks, active, plan } = fixture(), original = structuredClone(source);
  expectedRetirementPolicy(source, networks, active, plan);
  assert.deepEqual(source, original);
});

test('retirement expectation refuses a prefix already used by a surviving fleet', () => {
  const { source, networks, active, plan } = fixture(); source.fleets[1].prefix = 'retirement-generations/11111111-1111-4111-8111-111111111111';
  assert.throws(() => expectedRetirementPolicy(source, networks, active, plan), { code: 'ERR_ASSERTION' });
});
test('retirement expectation refuses an earlier retirement generation', () => {
  const { source, networks, active, plan } = fixture();
  const history = { original: { id: '11111111-1111-4111-8111-111111111111', previous: { prefix: 'original-prefix', nodes: ['original-node'] }, replacement: { prefix: 'retirement-generations/11111111-1111-4111-8111-111111111111', nodes: ['earlier-node'] } } };
  assert.throws(() => expectedRetirementPolicy(source, networks, active, plan, history), { code: 'ERR_ASSERTION' });
});
test('retirement expectation refuses a node identity from retained history', () => {
  const { source, networks, active, plan } = fixture();
  const history = { original: { id: '22222222-2222-4222-8222-222222222222', previous: { prefix: 'original-prefix', nodes: ['slot-1-a-11111111-1111-4111-8111-111111111111'] }, replacement: { prefix: 'earlier-replacement', nodes: ['earlier-node'] } } };
  assert.throws(() => expectedRetirementPolicy(source, networks, active, plan, history), { code: 'ERR_ASSERTION' });
});

const fleet = { prefix: 'new-prefix', nodes: [{ id: 'new-a' }, { id: 'new-b' }] };
test('an unassigned fleet permits only its own identity and bootstrap metadata', () => {
  assert.doesNotThrow(() => assertUnassignedNamespace([{ key: 'new-prefix/nodes/new-a.json' }, { key: 'new-prefix/nodes/new-b.json' }, { key: 'new-prefix/wake/format.json' }, { key: 'new-prefix/wake/waker.json' }, { key: 'new-prefix/fleet/capacity-v1.json' }], fleet));
});
for (const [name, objects] of [
  ['a deployment', [{ key: 'new-prefix/deploy/retired/current.json' }]],
  ['database state', [{ key: 'new-prefix/cells/__D1Database/own.json' }]],
  ['a pending timer', [{ key: 'new-prefix/wake/entries/old-job.json' }]],
  ['a retired timer', [{ key: 'new-prefix/wake/retired/old-job.json' }]],
  ['an arbitrary application object', [{ key: 'new-prefix/objects/private-data' }]],
  ['a former node lease', [{ key: 'new-prefix/nodes/old-a.json' }]],
  ['another namespace', [{ key: 'old-prefix/nodes/new-a.json' }]],
  ['duplicate metadata', [{ key: 'new-prefix/nodes/new-a.json' }, { key: 'new-prefix/nodes/new-a.json' }]],
  ['malformed metadata', [null]],
]) test(`an unassigned fleet refuses ${name}`, () => {
  assert.throws(() => assertUnassignedNamespace(objects, fleet), { code: 'ERR_ASSERTION' });
});
