// celld versions hash the materialized config, including private vars. Keep them
// in controller storage for readiness/recovery, not in API inspection responses.
export function adminDeployment(request) {
  if (!request.secretRevision) return request;
  const { version: _version, ...visible } = request;
  return visible;
}
export function adminState(controller) {
  return { ...controller.state, deployments: Object.fromEntries(Object.entries(controller.state.deployments).map(([id, request]) => [id, adminDeployment(request)])), secrets: controller.secrets.describe() };
}
