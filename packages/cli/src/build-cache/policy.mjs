import { uuid, digest, controllerOrigin } from './paths.mjs';
import { object, supportedController, supportedApplication, applicationOperationPending } from '../controller-schema.mjs';
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
const statuses = { active: 'active-submission', pending: 'pending-submission', activating: 'activation-in-progress', failed: 'retryable-failure', retired: 'retired-submission', rejected: 'terminal-copy', superseded: 'terminal-copy' };
export function retentionReason(record, state, origin, kept = false) {
  if (kept) return 'operator-kept';
  if (record.phase !== 'submitted') return 'unfinished-or-unconfirmed';
  if (record.server !== origin) return 'different-controller';
  if (!supportedController(state) || (Object.hasOwn(state.apps, record.app) && !supportedApplication(state.apps[record.app]))) return 'unsupported-controller-state';
  return submissionReason(record, state);
}
function submissionReason(record, state) {
  const request = Object.hasOwn(state.deployments, record.submission) ? state.deployments[record.submission] : null;
  if (!request || request.id !== record.submission || request.app !== record.app || request.digest !== record.digest) return 'unverified-submission';
  const app = Object.hasOwn(state.apps, record.app) ? state.apps[record.app] : null;
  if (app && (app.active === request.id || applicationOperationPending(app) || app.queueRecovery || app.cronRecovery)) return 'controller-or-recovery-reference';
  return statuses[request.status] || 'unrecognized-submission-state';
}
