import { artifactOnlyCronRequest, hasCronLifecycle, cronCapability } from '@fogd/platform/cron-history';
import { cronRecoveryCapability, cronRecoveryPending, cronSnapshotTarget, matchingCronSnapshot } from '@fogd/platform/cron-snapshot';

// Family inventory; callers validate the complete installation's capabilities.
export function cronRecoveryApps(state) {
  const declared = Object.values(state.deployments).filter(value => Object.hasOwn(value.resources || {}, 'crons'));
  const names = Object.keys(state.apps).filter(name => hasCronLifecycle(state.apps[name])).sort();
  if (!state.requirements?.includes(cronCapability)) {
    if (state.requirements?.includes(cronRecoveryCapability) || names.length || declared.length) throw new Error('Cron history requires its capability marker');
    return [];
  }
  const artifacts = declared.filter(request => artifactOnlyCronRequest(state, request));
  if ((!names.length && !artifacts.length) || declared.some(request => !artifacts.includes(request) && !names.includes(request.app))) throw new Error('Scheduled installation recovery requires an active app for every approved cron declaration');
  for (const name of names) {
    const { app } = cronSnapshotTarget(state, name);
    if (cronRecoveryPending(app)) throw new Error('Acknowledge existing cron recovery before backup');
  }
  return names;
}
export const cronSnapshotProtocol = { name: 'Cron', recovery: 'cronRecovery', capability: cronRecoveryCapability, legacy: 'scheduled', field: 'cronSnapshot', match: matchingCronSnapshot };
