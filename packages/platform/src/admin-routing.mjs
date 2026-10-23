import { checkMutation } from './admin-secrets.mjs';

export async function routingRequest(request, url, controller, csrf, body, send) {
  if (!controller.routes.durable) return false;
  const match = /^\/v1\/apps\/([a-z0-9-]+)\/routing(?:\/(pause|resume|reconcile|withhold-pending))?$/.exec(url.pathname);
  if (!match) return false;
  if (request.method === 'GET' && !match[2]) {
    send(200, await controller.routes.view(match[1])); return true;
  }
  if (request.method !== 'POST' || !match[2]) return false;
  try { checkMutation(request, csrf); }
  catch (error) { send(403, { error: error.message }); return true; }
  send(200, await controller.decideRoute(match[1], match[2], await body(request, 4096)));
  return true;
}
