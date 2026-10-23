import { join } from 'node:path';
import { planArtifactRetention } from './artifact-retention.mjs';
import { checkMutation } from './admin-secrets.mjs';

export async function artifactRequest(request, url, controller, csrf, body, send) {
  if (request.method === 'GET' && url.pathname === '/v1/admin/artifacts') {
    send(200, await controller.exclusive(() => planArtifactRetention(controller.state, join(controller.dir, 'artifacts'))));
    return true;
  }
  const match = /^\/v1\/admin\/artifacts\/([a-f0-9-]{36})\/(keep|unkeep)$/.exec(url.pathname);
  if (!match || request.method !== 'POST') return false;
  try { checkMutation(request, csrf); }
  catch (error) { send(403, { error: error.message }); return true; }
  const input = await body(request, 4096);
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join() !== 'digest') throw new Error('Artifact pin changes require only the exact artifact digest');
  send(200, await controller.setArtifactPin(match[1], input.digest, match[2] === 'keep'));
  return true;
}
