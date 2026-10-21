import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

const contracts = {
  full: [
    { from: 'initial', to: 'a', app: 'imports', surface: 'delivery', slot: 'slot-2', ordinary: false },
    { from: 'a', to: 'b', app: 'refresh', surface: 'dispatch', slot: 'slot-1', ordinary: false },
    { from: 'b', to: 'c', app: 'scheduled-next', surface: 'dispatch', slot: 'slot-1', ordinary: true },
    { from: 'c', to: 'd', app: 'replacement', surface: 'delivery', slot: 'slot-2', ordinary: true },
  ],
  dual: [
    { from: 'initial', to: 'a', app: 'imports', surface: 'delivery', slot: 'slot-2', ordinary: false },
    { from: 'a', to: 'dual', app: 'refresh', surface: 'dispatch', slot: 'slot-1', ordinary: false },
  ],
};
const qualifiedController = ['/app/qualification/controller.mjs'];
const ordinaryController = ['packages/platform/src/main.mjs'];

export function retirementPolicy(fleets, ids, mode) {
  assert.ok(typeof mode === 'string' && Object.hasOwn(contracts, mode), 'Unknown retirement qualification mode');
  const steps = contracts[mode];
  assert.deepEqual(fleets.map(fleet => fleet.id), ['slot-1', 'slot-2']);
  assert.deepEqual(Object.keys(ids).sort(), steps.map(step => step.to).sort(), 'Retirement generations differ from the fixed contract');
  assert.equal(new Set(Object.values(ids)).size, steps.length, 'Retirement generations must be distinct');
  for (const id of Object.values(ids)) assert.match(id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  const variants = { initial: { fleets: structuredClone(fleets), controllerArgs: [...qualifiedController] } };
  for (const step of steps) {
    const next = structuredClone(variants[step.from].fleets), fleet = next.find(value => value.id === step.slot);
    fleet.prefix = `retirement-generations/${ids[step.to]}`;
    fleet.nodes = fleet.nodes.map(node => ({ host: node.host, id: `${node.host}-${ids[step.to]}` }));
    variants[step.to] = { fleets: next, controllerArgs: [...(step.ordinary ? ordinaryController : qualifiedController)] };
  }
  return { mode, ids: structuredClone(ids), variants };
}
function checked(profile) {
  assert.deepEqual(Object.keys(profile.retirementArtifacts || {}).sort(), ['refresh', 'scheduled-next']);
  for (const pin of Object.values(profile.retirementArtifacts)) assert.match(pin, /^[a-f0-9]{64}$/);
  assert.equal(new Set(Object.values(profile.retirementArtifacts)).size, 2, 'Retirement artifact pins must distinguish both app names');
  const plan = profile.retirement;
  assert.ok(plan && typeof plan === 'object', 'Missing independently built retirement policy');
  assert.deepEqual(plan, retirementPolicy(profile.fleets, plan.ids, plan.mode), 'Retirement policy differs from its immutable contract');
  return plan;
}
export function retirementVariant(profile, variant) {
  const plan = checked(profile);
  assert.ok(typeof variant === 'string' && Object.hasOwn(plan.variants, variant), 'Unknown retirement variant');
  return { ...structuredClone(profile), ...structuredClone(plan.variants[variant]) };
}
export function variantSlots(profile, variant) {
  return retirementVariant(profile, variant).fleets.map(fleet => ({ id: fleet.id, prefix: fleet.prefix, nodes: fleet.nodes.map(node => node.host) }));
}
export function runtimeVariantName(profile, slots) {
  const plan = checked(profile);
  const matches = Object.keys(plan.variants).filter(variant => isDeepStrictEqual(variantSlots(profile, variant), slots));
  assert.equal(matches.length, 1, 'Runtime slots must match one complete preauthorized retirement variant');
  return matches[0];
}
export function runtimeVariant(profile, slots) { return retirementVariant(profile, runtimeVariantName(profile, slots)); }
export function retirementTransition(profile, variant, app) {
  const plan = checked(profile);
  const matches = contracts[plan.mode].filter(step => step.from === variant && step.app === app);
  assert.equal(matches.length, 1, 'Retirement is outside the preauthorized transition sequence');
  const step = matches[0];
  return { ...step, id: plan.ids[step.to], profile: retirementVariant(profile, step.to) };
}
export function retirementStage(profile, variant, command) {
  const plan = checked(profile);
  assert.ok(command && typeof command.id === 'string' && /^[a-f0-9-]{36}$/.test(command.id), 'Invalid retirement command identity');
  assert.equal(command.operation, 'stage');
  assert.ok(Object.keys(command).every(key => ['id', 'operation', 'app'].includes(key)), 'Retirement command cannot select paths, profiles or secrets');
  const name = Object.hasOwn(command, 'app') ? command.app : 'refresh';
  const allowed = variant === 'initial' ? 'refresh' : variant === (plan.mode === 'full' ? 'b' : 'a') ? 'scheduled-next' : null;
  assert.ok(typeof name === 'string' && name === allowed, 'Stage command is outside the immutable retirement sequence');
  assert.match(profile.retirementArtifacts?.[name] || '', /^[a-f0-9]{64}$/);
  return { name, source: `/var/lib/fogd/qualification/${name === 'refresh' ? 'artifact' : 'next-artifact'}`, digest: profile.retirementArtifacts[name] };
}

export function assertRetirementHistory(profile, variant, state) {
  const plan = checked(profile), history = [];
  let current = 'initial';
  for (const step of contracts[plan.mode]) {
    if (current === variant) break;
    history.push(step); current = step.to;
  }
  assert.equal(current, variant, 'Unknown retirement history');
  const actual = Object.entries(state.apps).filter(([, app]) => app.retirement).map(([app, value]) => ({ app, id: value.retirement.id }));
  const expected = history.map(step => ({ app: step.app, id: plan.ids[step.to] })).sort((a,b) => a.app.localeCompare(b.app));
  assert.deepEqual(actual.sort((a,b) => a.app.localeCompare(b.app)), expected, 'Retired generations differ from the independently authorized variant');
  for (const step of history) {
    const audit = state.apps[step.app].retirement, before = plan.variants[step.from].fleets.find(fleet => fleet.id === step.slot), next = plan.variants[step.to].fleets.find(fleet => fleet.id === step.slot);
    assert.deepEqual(audit.previous, { slot: step.slot, prefix: before.prefix, nodes: before.nodes.map(node => node.id) });
    assert.deepEqual(audit.replacement, { prefix: next.prefix, nodes: next.nodes.map(node => node.id) });
  }
  return expected;
}
