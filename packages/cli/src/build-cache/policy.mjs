import { uuid, digest, controllerOrigin } from './paths.mjs';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// These capability versions define the terminal-state and recovery contract.
const requirements = new Set(['fogd-claim-intent-v1', 'fogd-retirement-v1', 'fogd-queue-activation-v1', 'fogd-queue-recovery-v1', 'fogd-queue-retirement-v1', 'fogd-cron-activation-v1', 'fogd-cron-recovery-v1', 'fogd-cron-retirement-v1']);
const appFields = new Set(['slot', 'resources', 'migrations', 'active', 'route', 'uncertain', 'privateConfiguration', 'claim', 'quarantined', 'reason', 'retirement', 'delivery', 'dispatch', 'queueBootstrap', 'cronBootstrap', 'queueRecovery', 'cronRecovery', 'deliveryRecoveryError', 'dispatchRecoveryError']);
const phases = ['building', 'staged', 'failed', 'uploading', 'uncertain', 'submitted'];
const recordFields = ['schema', 'app', 'id', 'phase', 'digest', 'server', 'submission'];
export function validRecord(record, app, id) {
  if (!object(record) || record.schema !== 1 || record.app !== app || record.id !== id || !uuid(id)) return false;
  if (Object.keys(record).some(key => !recordFields.includes(key)) || !phases.includes(record.phase)) return false;
  return record.phase !== 'submitted' || validSubmission(record);
}
function validSubmission(record) {
  if (!uuid(record.submission) || !digest(record.digest) || typeof record.server !== 'string') return false;
  try { return controllerOrigin(record.server) === record.server; } catch { return false; }
}
function supportedState(state) {
  if (!object(state?.apps) || !object(state?.deployments)) return false;
  return state.requirements === undefined || (Array.isArray(state.requirements) && state.requirements.every(value => requirements.has(value)));
}
function supportedApp(state, name) {
  if (!Object.hasOwn(state.apps, name)) return true;
  const app = state.apps[name];
  return object(app) && Object.keys(app).every(key => appFields.has(key));
}
function operationPending(app) {
  if (['uncertain', 'claim', 'quarantined', 'retirement', 'queueRecovery', 'cronRecovery', 'deliveryRecoveryError', 'dispatchRecoveryError'].some(key => Boolean(app[key]))) return true;
  for (const key of ['delivery', 'dispatch']) if (app[key]?.hold || app[key]?.operation) return true;
  return ['queueBootstrap', 'cronBootstrap'].some(key => app[key] && app[key].phase !== 'application');
}
const statuses = { active: 'active-submission', pending: 'pending-submission', activating: 'activation-in-progress', failed: 'retryable-failure', retired: 'retired-submission', rejected: 'terminal-copy', superseded: 'terminal-copy' };
export function retentionReason(record, state, origin, kept = false) {
  if (kept) return 'operator-kept';
  if (record.phase !== 'submitted') return 'unfinished-or-unconfirmed';
  if (record.server !== origin) return 'different-controller';
  if (!supportedState(state) || !supportedApp(state, record.app)) return 'unsupported-controller-state';
  return submissionReason(record, state);
}
function submissionReason(record, state) {
  const request = Object.hasOwn(state.deployments, record.submission) ? state.deployments[record.submission] : null;
  if (!request || request.id !== record.submission || request.app !== record.app || request.digest !== record.digest) return 'unverified-submission';
  const app = Object.hasOwn(state.apps, record.app) ? state.apps[record.app] : null;
  if (app && (app.active === request.id || operationPending(app))) return 'controller-or-recovery-reference';
  return statuses[request.status] || 'unrecognized-submission-state';
}
