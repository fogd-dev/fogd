import { equal } from './security.mjs';

export function checkMutation(request, csrf) {
  if (!equal(request.headers['x-fogd-csrf'], csrf)) throw new Error('CSRF token required');
  const origin = request.headers.origin;
  if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) throw new Error('Origin mismatch');
}
export async function secretRequest(request, url, controller, csrf, body, send) {
  const match = /^\/v1\/apps\/([a-z0-9-]+)\/secrets$/.exec(url.pathname);
  if (!match || request.method !== 'PUT') return false;
  try { checkMutation(request, csrf); }
  catch (error) { send(403, { error: error.message }); return true; }
  const input = await body(request, 65536);
  send(200, await controller.replaceSecrets(match[1], input));
  return true;
}
