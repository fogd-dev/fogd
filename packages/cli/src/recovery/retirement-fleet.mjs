import { fleetLayout } from './layout.mjs';
import { overlap } from '@fogd/platform/retirement';

// Called only after the operation validates source ownership and capabilities.
// This changes one legacy-shaped fleet; durable callers re-seal the result.
export function planRetirementFleet(config, state, assigned, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid retirement generation');
  const fleets = fleetLayout(config);
  const slots = fleets.map(({ replicas, ...slot }) => slot);
  const slot = slots.find(s => s.id === assigned.slot);
  if (!slot) throw new Error('Retirement requires a configured local fleet');
  const prefix = `retirement-generations/${id}`;
  const existing = [...slots.map(s => s.prefix), ...Object.values(state.apps).filter(a => a.retirement).map(a => a.retirement.previous.prefix)];
  if (existing.some(old => overlap(old, prefix))) throw new Error('Replacement prefix overlaps retained storage');
  const next = structuredClone(config), services = fleets.find(f => f.id === slot.id).replicas;
  const previous = { slot: slot.id, prefix: slot.prefix, nodes: services.map(name => config.services[name].environment.CELLD_NODE) };
  for (const name of services) {
    const env = next.services[name].environment;
    if (env.CELLD_BUCKET !== `s3://${next.services.controller.environment.FOGD_BUCKET}/${slot.prefix}`) throw new Error('Replica bucket differs from controller ownership');
    env.CELLD_BUCKET = `s3://${next.services.controller.environment.FOGD_BUCKET}/${prefix}`;
    env.CELLD_NODE = `${name}-${id}`;
  }
  slot.prefix = prefix;
  for (const name of ['controller', 'workerd']) next.services[name].environment.FOGD_SLOTS = JSON.stringify(slots);
  return { config: next, slots, skipped: services, previous, replacement: { prefix, nodes: services.map(name => next.services[name].environment.CELLD_NODE) } };
}
