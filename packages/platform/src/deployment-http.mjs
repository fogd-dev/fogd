import { equal } from './security.mjs';
import { deploymentStatus } from './deployment-status.mjs';
import { positiveLimit } from './quota.mjs';
import { appName } from '@fogd/runtime/artifact';

export function deploymentHandler(controller, deployToken, body, maxUploads = 2) {
  const maximum = positiveLimit(maxUploads, 'Concurrent upload limit');
  let uploads = 0;
  async function submit(request, submitter, send) {
    if (uploads >= maximum) { send(429, { error: 'Upload capacity reached; retry later' }); return; }
    uploads++;
    try { send(201, await controller.submit(await body(request), submitter)); }
    finally { uploads--; }
  }
  return async (request, url, send) => {
    const submitting = url.pathname === '/v1/deployments' && request.method === 'POST';
    const capabilities = url.pathname === '/v1/capabilities' && request.method === 'GET';
    const match = request.method === 'GET' && /^\/v1\/deployments\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (!submitting && !match && !capabilities) return false;
    const identity = controller.credentials.authenticate(request.headers.authorization);
    const submitter = identity?.id || (deployToken && equal(request.headers.authorization, `Bearer ${deployToken}`) ? 'team-token' : null);
    if (!submitter) { send(401, { error: 'Unauthorized' }); return true; }
    controller.assertStorage();
    if (capabilities) {
      send(200, capabilitiesFor(controller, submitter, url.searchParams.get('app')));
      return true;
    }
    if (submitting) await submit(request, submitter, send);
    else {
      const release = controller.state.deployments[match[1]];
      if (release?.submitter !== submitter) send(404, { error: 'Deployment not found' });
      else send(200, deploymentStatus(release));
    }
    return true;
  };
}

function capabilitiesFor(controller, submitter, name) {
  const app = appName(name);
  if (submitter !== 'team-token') controller.credentials.requireScope(submitter, app);
  return { schema: 1, app, queueApps: controller.queueApps, cronApps: controller.cronApps && submitter !== 'team-token' };
}
