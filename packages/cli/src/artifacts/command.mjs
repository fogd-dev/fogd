import { configEnv, serverOrigin } from '../local.mjs';
import { controllerGet, boundedJson, discardResponse } from '../client-http.mjs';
import { artifactRetentionView } from './view.mjs';
import { artifactPinCommand } from './pins-command.mjs';

export async function artifactsCommand(args) {
  if (args.length === 3 && ['keep', 'unkeep'].includes(args[0])) return artifactPinCommand(args);
  if (args.length !== 1 || args[0] !== 'plan') throw new Error('Usage: fogd admin artifacts plan | keep|unkeep ID SHA');
  const env = await configEnv();
  if (!env.FOGD_ADMIN_PASSWORD) throw new Error('Set FOGD_ADMIN_PASSWORD for administrator artifact inspection');
  const authorization = `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER || 'admin'}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`;
  let response;
  try { response = await controllerGet(serverOrigin(env), '/v1/admin/artifacts', authorization); }
  catch { throw new Error('Cannot read controller artifacts; check its endpoint, TLS trust, and availability'); }
  await checkResponse(response);
  const plan = await boundedJson(response, { limit: 4 * 1024 ** 2,
    invalid: 'Controller returned unreadable artifact JSON; private response contents are withheld',
    interrupted: 'Artifact inspection was interrupted or timed out; inspect controller availability',
    oversized: 'Artifact retention plan exceeded the 4 MiB inspection limit' });
  console.log(JSON.stringify(artifactRetentionView(plan), null, 2));
}

async function checkResponse(response) {
  if (!response.ok) {
    await discardResponse(response);
    if ([401, 403].includes(response.status)) throw new Error('Administrator authentication was refused; check the selected installation credentials');
    if (response.status === 404) throw new Error('Controller does not provide artifact retention plans; use a runtime that supports this command');
    throw new Error(`Controller artifact inspection is unavailable (HTTP ${response.status})`);
  }
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await discardResponse(response); throw new Error('Controller did not return JSON artifact state; check the selected endpoint');
  }
}
