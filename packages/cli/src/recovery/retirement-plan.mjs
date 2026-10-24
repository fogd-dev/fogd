import { randomUUID } from 'node:crypto';
import { fleetLayout } from './layout.mjs';
import { retirementApp, retireState, validateRetirementState } from '@fogd/platform/retirement';
import { assertCronDockerTopology } from './cron-backup.mjs';
import { planRetirementFleet } from './retirement-fleet.mjs';

export function planRetirement(config, state, app, digest, { id = randomUUID(), at = new Date().toISOString(), snapshot, stopQueuedWork = false, stopScheduledWork = false } = {}) {
  assertCronDockerTopology(state, config);
  const assigned = retirementApp(state, app, digest, { stopQueuedWork, stopScheduledWork });
  validateRetirementState(state, fleetLayout(config));
  const fleet = planRetirementFleet(config, state, assigned, id);
  const evidence = { id, at, app, digest, snapshot, previous: fleet.previous, replacement: fleet.replacement };
  const retired = retireState(state, app, digest, evidence, { stopQueuedWork, stopScheduledWork });
  validateRetirementState(retired, fleet.slots);
  return { kind: 'retirement', config: fleet.config, state: retired, skipped: fleet.skipped, evidence };
}
