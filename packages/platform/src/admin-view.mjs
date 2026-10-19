import { capacity } from './capacity.mjs';

// celld versions hash the materialized config, including private vars. Keep them
// in controller storage for readiness/recovery, not in API inspection responses.
export function adminDeployment(request) {
  if (!request.secretRevision) return request;
  const { version: _version, ...visible } = request;
  return visible;
}
export function adminState(controller) {
  return { ...controller.state, apps: Object.fromEntries(Object.entries(controller.state.apps).map(([name, app]) => [name, adminApp(app)])), capacity: capacity(controller), deployments: Object.fromEntries(Object.entries(controller.state.deployments).map(([id, request]) => [id, adminDeployment(request)])), secrets: controller.secrets.describe(), credentials: controller.credentials.describe(), quota: controller.quota.describe() };
}

function adminApp(app) {
  const visible = { ...app };
  for (const field of ['delivery', 'queueBootstrap']) {
    if (!app[field]) continue;
    const { version: _version, ...state } = app[field];
    visible[field] = state;
  }
  return visible;
}
