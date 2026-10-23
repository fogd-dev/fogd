import { join } from 'node:path';
import { planArtifactRetention } from './artifact-retention.mjs';

export async function artifactRequest(request, url, controller, send) {
  if (request.method !== 'GET' || url.pathname !== '/v1/admin/artifacts') return false;
  const plan = await controller.exclusive(() => planArtifactRetention(controller.state, join(controller.dir, 'artifacts')));
  send(200, plan);
  return true;
}
