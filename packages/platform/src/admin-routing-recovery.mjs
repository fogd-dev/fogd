import { adminState } from './admin-view.mjs';
import { routingRequest } from './admin-routing.mjs';

export function assertRoutingServiceMode(controller, recoveryOnly) {
  if (typeof recoveryOnly !== 'boolean' || recoveryOnly && !controller.routingRecoveryAvailable) throw new Error('Routing recovery service requires inspected durable ownership');
  if ((controller.routingServiceRestricted || controller.routes.durable && !controller.routingStartupComplete) && !recoveryOnly) throw new Error('Durable controller requires a restricted routing recovery service');
}

export async function routingRecoveryRequest(request, url, controller, csrf, body, send) {
  if (request.method === 'GET' && url.pathname === '/v1/admin') {
    return send(200, { csrf, ...adminState(controller), recoveryOnly: true, routingStartupComplete: controller.routingStartupComplete, ingress: 'keep-stopped' });
  }
  const reductionOrReconciliation = /\/routing\/(pause|reconcile|withhold-pending)$/.test(url.pathname);
  if ((request.method === 'GET' || reductionOrReconciliation) && await routingRequest(request, url, controller, csrf, body, send)) return;
  send(503, { code: 'ROUTE_RECOVERY_ONLY', error: 'Controller is restricted to HTTP routing recovery; keep ingress stopped and restart after launch checks pass' });
}
