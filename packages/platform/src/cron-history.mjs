import { cronRecoveryCapability } from './cron-snapshot.mjs';
import { artifactOnlyBackgroundRequest } from './background-history.mjs';
import { cronScript, cronCapability, cronRetirementCapability } from './cron-dispatch.mjs';
export { cronCapability } from './cron-dispatch.mjs';

export function artifactOnlyCronRequest(state, request) {
  return artifactOnlyBackgroundRequest(state, request, cronCapability, (resources, app) => cronScript(resources) === app);
}
export function hasCronLifecycle(app) {
  return Boolean(app.resources && Object.hasOwn(app.resources, 'crons')) ||
    ['dispatch', 'cronBootstrap', 'cronSnapshot', 'cronRecovery', 'dispatchRecoveryError'].some(field => Object.hasOwn(app, field)) || Boolean(app.retirement?.cron);
}
export function hasCronHistory(state) {
  return state.requirements?.some(value => [cronCapability, cronRecoveryCapability, cronRetirementCapability].includes(value)) ||
    Object.values(state.apps).some(hasCronLifecycle) || Object.values(state.deployments).some(value => Object.hasOwn(value.resources || {}, 'crons'));
}
