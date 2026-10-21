import { validateRetiredCron, cronRetirementCapability } from '@fogd/platform/cron-retirement';
import { artifactOnlyCronRequest, hasCronLifecycle, cronCapability } from '@fogd/platform/cron-history';
import { cronRecoveryCapability, cronRecoveryPending, cronSnapshotTarget, matchingCronSnapshot } from '@fogd/platform/cron-snapshot';

// Family inventory; callers validate the complete installation's capabilities.
export function cronRecoveryApps(state) {
  const declared = Object.values(state.deployments).filter(value => Object.hasOwn(value.resources || {}, 'crons'));
  const retired = Object.keys(state.apps).filter(name => validateRetiredCron(state, name, state.apps[name]));
  const names = Object.keys(state.apps).filter(name => !state.apps[name].retirement && hasCronLifecycle(state.apps[name])).sort();
  if (!state.requirements?.includes(cronCapability)) {
    if ([cronRecoveryCapability, cronRetirementCapability].some(value => state.requirements?.includes(value)) || names.length || declared.length) throw new Error('Cron history requires its capability marker');
    return [];
  }
  const artifacts = declared.filter(request => artifactOnlyCronRequest(state, request));
  const accounted = [...names, ...retired];
  if ((!accounted.length && !artifacts.length) || declared.some(request => !artifacts.includes(request) && !accounted.includes(request.app))) throw new Error('Scheduled installation recovery requires an active app for every approved cron declaration');
  for (const name of names) {
    const { app } = cronSnapshotTarget(state, name);
    if (cronRecoveryPending(app)) throw new Error('Acknowledge existing cron recovery before backup');
  }
  return names;
}
export const cronSnapshotProtocol = { name: 'Cron', recovery: 'cronRecovery', capability: cronRecoveryCapability, legacy: 'scheduled', field: 'cronSnapshot', match: matchingCronSnapshot };
