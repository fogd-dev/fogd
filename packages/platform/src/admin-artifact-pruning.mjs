import { checkMutation } from './admin-secrets.mjs';

export async function artifactPruneRequest(request, url, controller, csrf, body, send) {
  const path = '/v1/admin/artifacts/prune';
  if (url.pathname === path && request.method === 'GET') {
    send(200, await controller.artifactPruneStatus()); return true;
  }
  const resume = /^\/v1\/admin\/artifacts\/prune\/([a-f0-9-]{36})\/resume$/.exec(url.pathname);
  if (request.method !== 'POST' || (url.pathname !== path && !resume)) return false;
  try { checkMutation(request, csrf); }
  catch (error) { send(403, { error: error.message }); return true; }
  const input = await body(request, 4096);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Pruning requires a JSON object');
  if (resume) {
    if (Object.keys(input).length) throw new Error('Prune resume accepts only the operation ID in its path');
    send(200, await controller.resumeArtifactPrune(resume[1]));
  } else {
    if (Object.keys(input).join() !== 'plan') throw new Error('Pruning requires only the reviewed plan digest');
    send(200, await controller.pruneArtifacts(input.plan));
  }
  return true;
}
