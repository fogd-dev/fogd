import { decisionHistoryCapability, validateDecisionHistory } from '@fogd/platform/decision-history';
import { artifactPruneCapability, validateArtifactPruning, validateArtifactPruningSummary } from '@fogd/platform/artifact-prune-state';
const requirements = new Set([decisionHistoryCapability, artifactPruneCapability, 'fogd-claim-intent-v1', 'fogd-retirement-v1', 'fogd-queue-activation-v1', 'fogd-queue-recovery-v1', 'fogd-queue-retirement-v1', 'fogd-cron-activation-v1', 'fogd-cron-recovery-v1', 'fogd-cron-retirement-v1']);
const appFields = new Set(['slot', 'resources', 'migrations', 'active', 'route', 'uncertain', 'privateConfiguration', 'claim', 'quarantined', 'reason', 'retirement', 'delivery', 'dispatch', 'queueBootstrap', 'cronBootstrap', 'queueRecovery', 'cronRecovery', 'deliveryRecoveryError', 'dispatchRecoveryError']);
export const object = value => value && typeof value === 'object' && !Array.isArray(value);
function supportedControllerWith(state, validatePruning, validateDecisions) {
  if (!object(state?.apps) || !object(state?.deployments) || (state.requirements !== undefined && (!Array.isArray(state.requirements) || !state.requirements.every(value => requirements.has(value))))) return false;
  try { validatePruning(state); validateDecisions(state); return true; }
  catch { return false; }
}
// Private disk state retains manifests; the authenticated owner view omits them.
export const supportedController = state => supportedControllerWith(state, validateArtifactPruning, validateDecisionHistory);
export const supportedControllerView = state => supportedControllerWith(state, validateArtifactPruningSummary, validateDecisionSummary);
export function supportedApplication(app, extraFields = []) {
  return object(app) && Object.keys(app).every(key => appFields.has(key) || extraFields.includes(key));
}

export function applicationOperationPending(app) {
  if (['uncertain', 'claim', 'quarantined', 'retirement', 'deliveryRecoveryError', 'dispatchRecoveryError'].some(key => Boolean(app[key]))) return true;
  for (const key of ['delivery', 'dispatch']) if (app[key]?.hold || app[key]?.operation) return true;
  return ['queueBootstrap', 'cronBootstrap'].some(key => app[key] && app[key].phase !== 'application');
}
export function applicationRecoveryPending(app) {
  return ['queueRecovery', 'cronRecovery'].some(key => app[key] && app[key].status !== 'acknowledged');
}

function validateDecisionSummary(state) {
  const summary = state.decisionHistory, required = state.requirements?.includes(decisionHistoryCapability);
  if (summary === undefined && !required) return;
  if (!object(summary) || Object.keys(summary).length !== 2 ||
      !['count', 'unconfirmed'].every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0) ||
      summary.unconfirmed > summary.count || (!required && summary.count !== 0)) throw new Error('Invalid decision history summary');
}
