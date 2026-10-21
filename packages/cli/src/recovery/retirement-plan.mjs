import { randomUUID } from 'node:crypto';
import { fleetLayout } from './layout.mjs';
import { retirementApp, retireState, overlap, validateRetirementState } from '@fogd/platform/retirement';
import { assertCronDockerTopology } from './cron-backup.mjs';

export function planRetirement(config, state, app, digest, { id = randomUUID(), at = new Date().toISOString(), snapshot, stopQueuedWork = false, stopScheduledWork = false } = {}) {
  assertCronDockerTopology(state, config);
  const assigned = retirementApp(state, app, digest, { stopQueuedWork, stopScheduledWork });
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid retirement generation');
  const fleets = fleetLayout(config);
  const slots = fleets.map(({ replicas, ...slot }) => slot);
  validateRetirementState(state, slots);
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
  const evidence = { id, at, app, digest, snapshot, previous, replacement: { prefix, nodes: services.map(name => next.services[name].environment.CELLD_NODE) } };
  const retired = retireState(state, app, digest, evidence, { stopQueuedWork, stopScheduledWork });
  validateRetirementState(retired, slots);
  return { kind: 'retirement', config: next, state: retired, skipped: services, evidence };
}
