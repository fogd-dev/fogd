import { checkMutation } from './admin-secrets.mjs';

export async function archiveRecoveryRequest(request, url, controller, csrf, body, send, actor) {
  if (!controller.archives?.enabled) return false;
  const match = /^\/v1\/apps\/([a-z0-9-]+)\/archive-recovery(?:\/(approve))?$/.exec(url.pathname);
  if (!match) return false;
  if (request.method === 'GET' && !match[2]) {
    send(200, await controller.archives.review(match[1])); return true;
  }
  if (request.method !== 'POST' || !match[2]) return false;
  try { checkMutation(request, csrf); }
  catch (error) { send(403, { error: error.message }); return true; }
  const input = await body(request, 4096);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Archive recovery approval requires a JSON object');
  const { review, ...selection } = input;
  send(200, await controller.archives.approve(match[1], selection, { actor, review }));
  return true;
}
