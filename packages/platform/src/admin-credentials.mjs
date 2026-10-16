import { checkMutation } from './admin-secrets.mjs';

export async function credentialRequest(request, url, controller, csrf, body, send) {
  const creating = url.pathname === '/v1/credentials' && request.method === 'POST';
  const revoking = request.method === 'POST' && /^\/v1\/credentials\/([a-f0-9-]{36})\/revoke$/.exec(url.pathname);
  if (!creating && !revoking) return false;
  try { checkMutation(request, csrf); }
  catch (error) { send(403, { error: error.message }); return true; }
  const input = await body(request, 65536);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected a credential request object');
  send(200, creating ? await controller.issueCredential(input.name, input.apps) : await controller.revokeCredential(revoking[1]));
  return true;
}
