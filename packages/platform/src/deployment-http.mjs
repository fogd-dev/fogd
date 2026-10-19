import { equal } from './security.mjs';
import { deploymentStatus } from './deployment-status.mjs';
import { positiveLimit } from './quota.mjs';

export function deploymentHandler(controller, deployToken, body, maxUploads = 2) {
  const maximum = positiveLimit(maxUploads, 'Concurrent upload limit');
  let uploads = 0;
  return async (request, url, send) => {
    const submitting = url.pathname === '/v1/deployments' && request.method === 'POST';
    const match = request.method === 'GET' && /^\/v1\/deployments\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (!submitting && !match) return false;
    const identity = controller.credentials.authenticate(request.headers.authorization);
    const submitter = identity?.id || (deployToken && equal(request.headers.authorization, `Bearer ${deployToken}`) ? 'team-token' : null);
    if (!submitter) { send(401, { error: 'Unauthorized' }); return true; }
    controller.assertStorage();
    if (submitting) {
      if (uploads >= maximum) send(429, { error: 'Upload capacity reached; retry later' });
      else {
        uploads++;
        try { send(201, await controller.submit(await body(request), submitter)); }
        finally { uploads--; }
      }
    } else {
      const release = controller.state.deployments[match[1]];
      if (release?.submitter !== submitter) send(404, { error: 'Deployment not found' });
      else send(200, deploymentStatus(release));
    }
    return true;
  };
}
