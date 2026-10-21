import test from 'node:test';
import assert from 'node:assert/strict';
import { planRetirement } from '../../../packages/cli/src/recovery/retirement-plan.mjs';
import { retirementPolicy, retirementVariant, variantSlots, retirementTransition } from './policy.mjs';

const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222', c = '33333333-3333-4333-8333-333333333333', d = '44444444-4444-4444-8444-444444444444';
function authority(mode) {
  const fleets = [{ id: 'slot-1', prefix: 'slots/slot-1', nodes: [{ host: 'slot-1-a', id: 'slot-1-a' }, { host: 'slot-1-b', id: 'slot-1-b' }] }, { id: 'slot-2', prefix: 'slots/slot-2', nodes: [{ host: 'slot-2-a', id: 'slot-2-a' }, { host: 'slot-2-b', id: 'slot-2-b' }] }];
  return { fleets, retirement: retirementPolicy(fleets, mode === 'full' ? { a, b, c, d } : { a, dual: b }, mode), retirementArtifacts: { refresh: 'a'.repeat(64), 'scheduled-next': 'b'.repeat(64) } };
}
function topology(profile, variant) {
  const slots = JSON.stringify(variantSlots(profile, variant));
  const config = { services: { controller: { environment: { FOGD_BUCKET: 'qualified-bucket', FOGD_SLOTS: slots } }, workerd: { environment: { FOGD_SLOTS: slots } } } };
  for (const fleet of retirementVariant(profile, variant).fleets) for (const node of fleet.nodes) config.services[node.host] = { environment: { CELLD_BUCKET: `s3://qualified-bucket/${fleet.prefix}`, CELLD_NODE: node.id } };
  return config;
}
// Compare two independent modules at their identity-plan seam. The separate
// policy tests pin literal outcomes; these catch drift in the production planner.
for (const row of [
  { mode: 'full', from: 'initial', to: 'a', app: 'imports', slot: 'slot-2', id: a },
  { mode: 'full', from: 'a', to: 'b', app: 'refresh', slot: 'slot-1', id: b },
  { mode: 'full', from: 'b', to: 'c', app: 'scheduled-next', slot: 'slot-1', id: c },
  { mode: 'full', from: 'c', to: 'd', app: 'replacement', slot: 'slot-2', id: d },
  { mode: 'dual', from: 'initial', to: 'a', app: 'imports', slot: 'slot-2', id: a },
  { mode: 'dual', from: 'a', to: 'dual', app: 'refresh', slot: 'slot-1', id: b },
]) test(`${row.mode}: ${row.from} to ${row.to} agrees with production namespace and node planning`, () => {
  const profile = authority(row.mode), selected = retirementTransition(profile, row.from, row.app);
  const state = { apps: { [row.app]: { slot: row.slot, active: 'release', route: 'active' } }, deployments: { release: { app: row.app, status: 'active', digest: 'e'.repeat(64) } } };
  const plan = planRetirement(topology(profile, row.from), state, row.app, 'e'.repeat(64), { id: row.id, at: '2026-10-21T00:00:00.000Z', snapshot: { bytes: 10, sha256: 'f'.repeat(64) } });
  assert.equal(selected.id, row.id); assert.equal(selected.to, row.to);
  assert.deepEqual(JSON.parse(plan.config.services.controller.environment.FOGD_SLOTS), variantSlots(profile, row.to));
  const fleet = selected.profile.fleets.find(value => value.id === row.slot);
  assert.deepEqual(plan.evidence.replacement, { prefix: fleet.prefix, nodes: fleet.nodes.map(node => node.id) });
});
