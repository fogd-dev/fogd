import { queueCapability } from './queue-activation.mjs';
import { queueRecoveryCapability } from './queue-snapshot.mjs';
import { queueRetirementCapability, assertQueueRetirement, retainRetiredQueue, validateRetiredQueue } from './queue-retirement.mjs';
import { claimCapability } from './claims.mjs';
import { cronRecoveryCapability } from './cron-snapshot.mjs';
import { cronCapability } from './cron-dispatch.mjs';
import { appName } from '@fogd/runtime/artifact';

export const retirementCapability = 'fogd-retirement-v1';
export function assertLiveName(state, name) {
  if (state.apps[name]?.retirement) throw new Error('App name is permanently retired; choose a different name');
}
export function validateRetirementState(state, slots) {
  if ((state.requirements || []).some(value => ![retirementCapability, claimCapability, queueCapability, queueRecoveryCapability, queueRetirementCapability, cronCapability, cronRecoveryCapability].includes(value))) throw new Error('Controller state requires an unsupported platform capability');
  for (const [name, app] of Object.entries(state.apps)) {
    if (!app.retirement) continue;
    if (!state.requirements?.includes(retirementCapability) || app.slot !== null || app.route !== 'retired') throw new Error('Invalid retirement tombstone; restore matching metadata');
    const prefix = app.retirement.previous.prefix;
    if (!prefix || slots.some(slot => overlap(slot.prefix, prefix))) throw new Error('Configured bucket prefix overlaps retired data; restore matching configuration');
    validateRetiredQueue(state, name, app);
  }
}
export const overlap = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
export function retirementApp(state, name, digest, { stopQueuedWork = false } = {}) {
  appName(name); assertLiveName(state, name);
  const app = state.apps[name], active = state.deployments[app?.active];
  if (app?.dispatch || app?.resources?.crons) throw new Error('Scheduled app retirement is not qualified');
  assertQueueRetirement(state, name, stopQueuedWork);
  if (!app || !active) throw new Error('Retirement requires an existing activated app');
  if (app.quarantined || app.uncertain || !['active', 'paused'].includes(app.route) || active.status !== 'active') throw new Error('Retirement requires a known active version with reconciled migrations');
  if (active.app !== name || active.digest !== digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Retirement active artifact digest mismatch');
  if (Object.values(state.deployments).some(d => d.app === name && d.status === 'activating')) throw new Error('Retirement refuses an interrupted activation');
  return app;
}
export function retireState(state, name, digest, evidence, options) {
  const app = retirementApp(state, name, digest, options);
  if (evidence.previous.slot !== app.slot || !evidence.previous.prefix || !evidence.replacement.prefix || overlap(evidence.previous.prefix, evidence.replacement.prefix)) throw new Error('Retirement identity plan does not match the app');
  const next = structuredClone(state);
  next.requirements = [...new Set([...(next.requirements || []), retirementCapability])];
  next.apps[name] = { ...next.apps[name], slot: null, route: 'retired', retirement: { ...evidence, digest, deployment: app.active } };
  if (app.resources?.queues) {
    next.apps[name].retirement.queue = retainRetiredQueue(next.apps[name]);
    next.requirements.push(queueRetirementCapability);
    next.requirements = [...new Set(next.requirements)];
  }
  for (const deployment of Object.values(next.deployments)) {
    if (deployment.app === name && ['pending', 'failed', 'active'].includes(deployment.status)) deployment.status = 'retired';
  }
  return next;
}
