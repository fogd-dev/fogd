import test from 'node:test';
import assert from 'node:assert/strict';
import { retirementPolicy, retirementVariant, variantSlots, runtimeVariant, runtimeVariantName, retirementTransition, retirementStage, assertRetirementHistory } from './policy.mjs';
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222', c = '33333333-3333-4333-8333-333333333333', d = '44444444-4444-4444-8444-444444444444';
const fleets = () => [{ id: 'slot-1', prefix: 'slots/slot-1', nodes: [{ host: 'slot-1-a', id: 'slot-1-a' }, { host: 'slot-1-b', id: 'slot-1-b' }] }, { id: 'slot-2', prefix: 'slots/slot-2', nodes: [{ host: 'slot-2-a', id: 'slot-2-a' }, { host: 'slot-2-b', id: 'slot-2-b' }] }];
const fixture = () => ({ fleets: fleets(), retirement: retirementPolicy(fleets(), { a, b, c, d }, 'full'), retirementArtifacts: { refresh: 'a'.repeat(64), 'scheduled-next': 'b'.repeat(64) } });
const command = app => ({ id: a, operation: 'stage', app });

test('queued retirement preauthorizes only its new slot identity and preserves the cron fleet', () => {
  const profile = fixture(), selected = retirementTransition(profile, 'initial', 'imports');
  assert.equal(selected.id, a); assert.equal(selected.to, 'a'); assert.equal(selected.slot, 'slot-2');
  assert.deepEqual(selected.profile.fleets[0], fleets()[0]);
  assert.deepEqual(selected.profile.fleets[1], { id: 'slot-2', prefix: 'retirement-generations/'+a, nodes: [{ host: 'slot-2-a', id: 'slot-2-a-'+a }, { host: 'slot-2-b', id: 'slot-2-b-'+a }] });
  assert.deepEqual(profile.fleets, fleets());
});
test('ordinary controller launch is authorized before queue-only and zero-live target creation', () => {
  assert.deepEqual(retirementVariant(fixture(), 'c').controllerArgs, ['packages/platform/src/main.mjs']);
  assert.deepEqual(retirementVariant(fixture(), 'd').controllerArgs, ['packages/platform/src/main.mjs']);
  assert.deepEqual(retirementVariant(fixture(), 'b').controllerArgs, ['/app/qualification/controller.mjs']);
});
test('runtime selection matches the entire inventory rather than a union of allowed fleets', () => {
  const profile = fixture(), mixed = variantSlots(profile, 'b'); mixed[1].prefix = 'retirement-generations/'+d;
  assert.throws(() => runtimeVariant(profile, mixed), /complete preauthorized/);
  assert.deepEqual(runtimeVariant(profile, variantSlots(profile, 'b')).fleets, retirementVariant(profile, 'b').fleets);
});
test('unplanned retirement order, names and combined state variants are refused', () => {
  assert.throws(() => retirementTransition(fixture(), 'initial', 'refresh'), /preauthorized transition/);
  assert.throws(() => retirementTransition(fixture(), 'a', 'imports'), /preauthorized transition/);
  assert.throws(() => retirementVariant(fixture(), 'constructor'), /Unknown retirement variant/);
});
test('runtime variant selection ignores object key serialization order', () => {
  const slots = [{ nodes: ['slot-1-a', 'slot-1-b'], prefix: 'slots/slot-1', id: 'slot-1' },
    { nodes: ['slot-2-a', 'slot-2-b'], prefix: 'retirement-generations/'+a, id: 'slot-2' }];
  assert.equal(runtimeVariantName(fixture(), slots), 'a');
});
test('changed variant policy cannot authorize another storage namespace', () => {
  const profile = fixture(); profile.retirement.variants.a.fleets[1].prefix = 'attacker/prefix';
  assert.throws(() => retirementVariant(profile, 'a'), /immutable contract/);
});
test('retirement generation sets must match the selected contract and be unique', () => {
  assert.throws(() => retirementPolicy(fleets(), { a, b }, 'full'), /generations differ/);
  assert.throws(() => retirementPolicy(fleets(), { a, b: a, c, d }, 'full'), /distinct/);
});
test('dual retirement preserves its separately authorized survivor fleet', () => {
  const profile = fixture(); profile.retirement = retirementPolicy(fleets(), { a, dual: b }, 'dual');
  const selected = retirementTransition(profile, 'a', 'refresh');
  assert.equal(selected.to, 'dual'); assert.equal(selected.id, b);
  assert.equal(selected.profile.fleets[1].prefix, 'retirement-generations/'+a);
  assert.deepEqual(selected.profile.controllerArgs, ['/app/qualification/controller.mjs']);
});
test('stage commands choose only the exact artifact and permitted variant', () => {
  assert.deepEqual(retirementStage(fixture(), 'initial', command('refresh')), { name: 'refresh', source: '/var/lib/fogd/qualification/artifact', digest: 'a'.repeat(64) });
  assert.equal(retirementStage(fixture(), 'b', command('scheduled-next')).source, '/var/lib/fogd/qualification/next-artifact');
  assert.throws(() => retirementStage(fixture(), 'a', command('scheduled-next')), /immutable retirement sequence/);
  assert.throws(() => retirementStage(fixture(), 'b', command('refresh')), /immutable retirement sequence/);
});
test('stage data cannot supply executable paths, profile policy or secret values', () => {
  assert.throws(() => retirementStage(fixture(), 'initial', { ...command('refresh'), source: '/tmp/app' }), /cannot select/);
  assert.throws(() => retirementStage(fixture(), 'initial', { ...command('refresh'), profile: {} }), /cannot select/);
  assert.throws(() => retirementStage(fixture(), 'initial', { ...command('refresh'), secret: 'value' }), /cannot select/);
  assert.throws(() => retirementStage(fixture(), 'initial', command(['refresh'])), /immutable retirement sequence/);
});

test('retired generation history must agree with the chosen launch variant', () => {
  assert.throws(() => assertRetirementHistory(fixture(), 'a', { apps: {} }), /Retired generations differ/);
});
test('an unexpected retirement cannot be smuggled into the initial variant', () => {
  assert.throws(() => assertRetirementHistory(fixture(), 'initial', { apps: { imports: { retirement: { id: a } } } }), /Retired generations differ/);
});
test('the initial variant accepts an empty retirement history', () => {
  assert.deepEqual(assertRetirementHistory(fixture(), 'initial', { apps: {} }), []);
});
test('retired history pins both the old and replacement identities', () => {
  const state = { apps: { imports: { retirement: { id: a,
    previous: { slot: 'slot-2', prefix: 'slots/slot-2', nodes: ['slot-2-a', 'slot-2-b'] },
    replacement: { prefix: 'retirement-generations/'+a, nodes: ['slot-2-a-'+a, 'slot-2-b-'+a] },
  } } } };
  assert.deepEqual(assertRetirementHistory(fixture(), 'a', state), [{ app: 'imports', id: a }]);
  const wrongOld = structuredClone(state); wrongOld.apps.imports.retirement.previous.nodes[0] = 'another-node';
  assert.throws(() => assertRetirementHistory(fixture(), 'a', wrongOld), { code: 'ERR_ASSERTION' });
  const wrongNew = structuredClone(state); wrongNew.apps.imports.retirement.replacement.prefix = 'another-namespace';
  assert.throws(() => assertRetirementHistory(fixture(), 'a', wrongNew), { code: 'ERR_ASSERTION' });
});
test('inherited artifact pins cannot authorize staging', () => {
  const profile = fixture(); profile.retirementArtifacts = Object.create({ refresh: 'a'.repeat(64), 'scheduled-next': 'b'.repeat(64) });
  assert.throws(() => retirementStage(profile, 'initial', command('refresh')), { code: 'ERR_ASSERTION' });
});
test('identical artifact pins cannot erase the app-name boundary', () => {
  const profile = fixture(); profile.retirementArtifacts['scheduled-next'] = 'a'.repeat(64);
  assert.throws(() => retirementStage(profile, 'initial', command('refresh')), /distinguish both app names/);
});
