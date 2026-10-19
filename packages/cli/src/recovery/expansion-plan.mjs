import { addFleet } from '../compose/add-fleet.mjs';
import { randomUUID } from 'node:crypto';
import { overlap, validateRetirementState } from '@fogd/platform/retirement';
import { fleetLayout } from './layout.mjs';
import { validateTopology } from './bundle.mjs';

export function planExpansion(config, state, images, { id = randomUUID(), at = new Date().toISOString(), snapshot } = {}) {
  validateTopology(config);
  const fleets = fleetLayout(config);
  if (fleets.length !== 2) throw new Error('Expansion requires a two-fleet source and a three-fleet target');
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid expansion generation');
  validateRetirementState(state, fleets);
  const prefix = `expansion-generations/${id}`;
  const retained = [...fleets.map(f => f.prefix), ...Object.values(state.apps).filter(a => a.retirement).map(a => a.retirement.previous.prefix)];
  if (retained.some(old => overlap(old, prefix))) throw new Error('Expansion prefix overlaps retained storage');
  const replicas = ['slot-3-a', 'slot-3-b'];
  const next = addFleet(config, 'slot-2', { id: 'slot-3', prefix, nodes: replicas }, replicas.map(name => `${name}-${id}`));
  const nextImages = { ...images };
  for (const [i, name] of replicas.entries()) nextImages[name] = images[fleets[1].replicas[i]];
  validateTopology(next);
  return { kind: 'expansion', config: next, images: nextImages, skipped: replicas, evidence: { id, at, snapshot, previousFleets: 2, fleets: 3, added: { slot: 'slot-3', prefix, nodes: replicas.map(name => next.services[name].environment.CELLD_NODE) } } };
}
