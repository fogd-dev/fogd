import { configEnv, serverOrigin } from './local.mjs';
import { controllerGet, boundedJson, discardResponse } from './client-http.mjs';
import { submitterStatus } from './submitter-status.mjs';

export async function status(id) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || '')) throw new Error('Usage: fogd status <deployment-id>');
  const env = await configEnv();
  if (!env.FOGD_DEPLOY_TOKEN) throw new Error('Set FOGD_DEPLOY_TOKEN');
  let response;
  try { response = await controllerGet(serverOrigin(env), `/v1/deployments/${id}`, `Bearer ${env.FOGD_DEPLOY_TOKEN}`); }
  catch { throw new Error('Cannot read submission status; check the controller endpoint, TLS trust, and availability'); }
  if (!response.ok) { await discardResponse(response); throw new Error(statusFailure(response.status)); }
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await discardResponse(response); throw new Error('Controller did not return JSON submission status; check the selected endpoint');
  }
  const input = await boundedJson(response, { limit: 64 * 1024,
    invalid: 'Controller returned unreadable JSON status; private response contents are withheld',
    interrupted: 'Submission status read was interrupted or timed out; inspect controller availability before acting',
    oversized: 'Submission status exceeded the 64 KiB read limit; check controller compatibility' });
  console.log(JSON.stringify(submitterStatus(input, id), null, 2));
}
function statusFailure(status) {
  if ([401, 403].includes(status)) return 'Deployment authentication was refused; check the selected deploy credential';
  if (status === 404) return 'Submission is unavailable to this deploy credential; check its ID and the credential that submitted it';
  return `Submission status is unavailable (HTTP ${status}); inspect controller availability before acting`;
}
