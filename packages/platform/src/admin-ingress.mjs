import { checkMutation } from './admin-secrets.mjs';

export async function ingressRequest(request, url, controller, csrf, body, send) {
  if (!controller.routes.durable || request.method !== 'POST' || url.pathname !== '/v1/admin/routing/preflight') return false;
  try { checkMutation(request, csrf); }
  catch (error) { send(403, { error: error.message }); return true; }
  send(200, await controller.preflightIngress(await body(request, 4096)));
  return true;
}
