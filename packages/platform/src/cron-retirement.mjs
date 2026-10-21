import { isDeepStrictEqual } from 'node:util';
import { cronScript, cronCapability, cronRetirementCapability, validateCronDispatch } from './cron-dispatch.mjs';
import { matchingCronSnapshot, validateCronSnapshot, validateCronRecoveryState } from './cron-snapshot.mjs';

export { cronRetirementCapability } from './cron-dispatch.mjs';
const operationalFields = ['dispatch', 'cronBootstrap', 'cronSnapshot', 'cronRecovery', 'dispatchRecoveryError'];

export function assertCronRetirement(state, name, stopScheduledWork) {
  const app = state.apps[name];
  if (!app?.resources || !Object.hasOwn(app.resources, 'crons')) {
    if (operationalFields.some(field => Object.hasOwn(app || {}, field))) throw new Error('Scheduled state lacks its cron resource declaration; restore matching metadata');
    if (stopScheduledWork) throw new Error('--stop-scheduled-work requires a scheduled app');
    return;
  }
  if (stopScheduledWork !== true) throw new Error('Cron retirement requires --stop-scheduled-work; pending timer and retry identity will not run in the replacement fleet');
  if (app.cronRecovery && app.cronRecovery.status !== 'acknowledged') throw new Error('Acknowledge restored cron recovery before retirement');
  if (Object.hasOwn(app, 'dispatchRecoveryError')) throw new Error('Reconcile cron dispatch recovery before retirement');
  matchingCronSnapshot(state, name, app.cronSnapshot);
}

export function retainRetiredCron(app) {
  const audit = { stopScheduledWork: true, prepared: structuredClone(app.cronSnapshot),
    dispatch: structuredClone(app.dispatch), bootstrap: structuredClone(app.cronBootstrap),
    recovery: structuredClone(app.cronRecovery || null) };
  for (const field of operationalFields) delete app[field];
  return audit;
}

export function validateRetiredCron(state, name, app) {
  if (!app.retirement) return false;
  const audit = app.retirement.cron;
  if (app.slot !== null || app.route !== 'retired' || operationalFields.some(field => Object.hasOwn(app, field))) throw new Error('Retired crons cannot retain operational dispatch state');
  if (!Object.hasOwn(app.resources || {}, 'crons') && !audit) return false;
  if (![cronRetirementCapability, cronCapability, 'fogd-retirement-v1'].every(value => state.requirements?.includes(value)) || audit?.stopScheduledWork !== true) throw new Error('Cron retirement requires its capability and stopped-work audit');
  validateCronSnapshot(audit.prepared); validateCronDispatch(audit.dispatch);
  validateRetiredApproval(state, name, app, audit);
  validateRetiredDispatch(state, name, audit);
  return true;
}

function validateRetiredApproval(state, name, app, audit) {
  const retired = app.retirement, prepared = audit.prepared, active = state.deployments[retired.deployment];
  if (!active || active.app !== name || active.status !== 'retired' || active.digest !== retired.digest || app.active !== retired.deployment) throw new Error('Cron retirement does not identify its retired approval');
  const identity = { deployment: retired.deployment, digest: retired.digest, slot: retired.previous.slot, version: active.version, secretRevision: active.secretRevision };
  if (Object.keys(identity).some(key => prepared[key] !== identity[key])) throw new Error('Cron retirement preparation differs from its approval');
  for (const resources of [app.resources, active.resources]) validateRetiredSchedule(name, resources, prepared);
  if (audit.dispatch.script !== name || audit.dispatch.version !== prepared.version || !/^[a-f0-9]{64}$/.test(retired.snapshot?.sha256 || '')) throw new Error('Cron retirement lacks matching dispatch and snapshot evidence');
  if (Object.values(state.deployments).some(request => request.app === name && !['retired', 'superseded', 'rejected'].includes(request.status))) throw new Error('Retired cron declarations cannot retain live approval state');
}

function validateRetiredSchedule(name, resources, prepared) {
  if (cronScript(resources) !== name || prepared.script !== name || !isDeepStrictEqual(prepared.crons, resources.crons)) throw new Error('Cron retirement schedule differs from its approval');
}

function validateRetiredDispatch(state, name, audit) {
  if (audit.dispatch.hold || audit.dispatch.operation || audit.dispatch.desired !== 'paused' || audit.dispatch.observed !== 'paused' || audit.bootstrap?.phase !== 'application') throw new Error('Cron retirement audit does not confirm completed paused activation');
  if (audit.recovery && audit.recovery.status !== 'acknowledged') throw new Error('Cron retirement contains unresolved recovery');
  if (audit.recovery) {
    validateCronRecoveryState({ requirements: state.requirements, apps: { [name]: { dispatch: audit.dispatch, cronRecovery: audit.recovery } } });
    validateRetiredRecovery(state, name, audit.recovery);
  }
}

function validateRetiredRecovery(state, name, recovery) {
  const prepared = recovery.prepared, approved = state.deployments[prepared.deployment];
  if (!approved || approved.app !== name || !['retired', 'superseded'].includes(approved.status) || prepared.script !== name || prepared.digest !== approved.digest || prepared.version !== approved.version || prepared.secretRevision !== approved.secretRevision) throw new Error('Retired cron recovery does not identify an approval of this app');
  if (cronScript(approved.resources) !== name || !isDeepStrictEqual(prepared.crons, approved.resources.crons) || recovery.unexpectedDispatch || recovery.unexpectedRevision || recovery.checkError) throw new Error('Retired cron recovery contains unconfirmed dispatch findings');
}
