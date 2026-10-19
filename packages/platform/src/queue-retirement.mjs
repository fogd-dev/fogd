import { validateRecoveryState } from './queue-recovery.mjs';
import { activationQueue } from './queue-activation.mjs';
import { validateDelivery } from './delivery.mjs';
import { matchingSnapshot, validateSnapshot } from './queue-snapshot.mjs';

export const queueRetirementCapability = 'fogd-queue-retirement-v1';
const operationalFields = ['delivery', 'queueBootstrap', 'queueSnapshot', 'queueRecovery', 'deliveryRecoveryError'];

export function assertQueueRetirement(state, name, stopQueuedWork) {
  const app = state.apps[name];
  if (!app?.resources?.queues) {
    if (app?.delivery) throw new Error('Delivery state lacks its queue resource declaration; restore matching metadata');
    if (stopQueuedWork) throw new Error('--stop-queued-work requires a queued app');
    return;
  }
  if (stopQueuedWork !== true) throw new Error('Queue retirement requires --stop-queued-work; pending work will not run in the replacement fleet');
  if (app.queueRecovery && app.queueRecovery.status !== 'acknowledged') throw new Error('Acknowledge restored queue recovery before retirement');
  matchingSnapshot(state, name, app.queueSnapshot);
}

export function retainRetiredQueue(app) {
  const audit = { stopQueuedWork: true, prepared: structuredClone(app.queueSnapshot),
    delivery: structuredClone(app.delivery), bootstrap: structuredClone(app.queueBootstrap),
    recovery: structuredClone(app.queueRecovery || null) };
  for (const field of operationalFields) delete app[field];
  return audit;
}

export function validateRetiredQueue(state, name, app) {
  if (!app.retirement) return false;
  if (app.slot !== null || app.route !== 'retired' || operationalFields.some(field => Object.hasOwn(app, field))) throw new Error('Retired queues cannot retain operational delivery state');
  const audit = app.retirement.queue;
  if (!app.resources?.queues && !audit) return false;
  if (!state.requirements?.includes(queueRetirementCapability) || !['fogd-queue-activation-v1', 'fogd-retirement-v1'].every(capability => state.requirements.includes(capability)) || !audit || audit.stopQueuedWork !== true) throw new Error('Queued retirement requires its capability and stopped-work audit');
  validateSnapshot(audit.prepared); validateDelivery(audit.delivery);
  validateRetiredIdentity(state, name, app, audit);
  validateRetiredDelivery(state, name, audit);
  return true;
}

function validateRetiredIdentity(state, name, app, audit) {
  const retired = app.retirement, prepared = audit.prepared;
  const active = state.deployments[retired.deployment];
  if (!active || active.app !== name || active.status !== 'retired' || active.digest !== retired.digest || app.active !== retired.deployment) throw new Error('Queued retirement does not identify its retired approval');
  if (prepared.deployment !== retired.deployment || prepared.digest !== retired.digest || prepared.slot !== retired.previous.slot || prepared.version !== active.version || prepared.queue !== activationQueue(app.resources)) throw new Error('Queued retirement preparation differs from its approval');
  if (audit.delivery.version !== prepared.version || audit.delivery.queue !== prepared.queue || !/^[a-f0-9]{64}$/.test(retired.snapshot?.sha256 || '')) throw new Error('Queued retirement lacks matching delivery and snapshot evidence');
}

function validateRetiredDelivery(state, name, audit) {
  if (audit.delivery.hold || audit.delivery.operation || audit.delivery.desired !== 'paused' || audit.delivery.observed !== 'paused' || audit.bootstrap?.phase !== 'application') throw new Error('Queued retirement audit does not confirm completed paused activation');
  if (audit.recovery && audit.recovery.status !== 'acknowledged') throw new Error('Queued retirement contains unresolved recovery');
  if (audit.recovery) validateRecoveryState({ requirements: state.requirements, apps: { [name]: { delivery: audit.delivery, queueRecovery: audit.recovery } } });
}
