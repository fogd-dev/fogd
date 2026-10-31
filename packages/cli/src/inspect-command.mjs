import { controllerGet, boundedJson, discardResponse } from './client-http.mjs';
import { appName } from '@fogd/runtime/artifact';
import { configEnv, serverOrigin } from './local.mjs';
import { applicationInspection } from './inspection.mjs';

export async function adminInspect(name, digest, revision) {
  if (!name || digest !== undefined || revision !== undefined) throw new Error('Usage: fogd admin inspect APP');
  appName(name);
  const state = await readAdminSnapshot(await configEnv());
  console.log(JSON.stringify(applicationInspection(state, name), null, 2));
}
export async function readAdminSnapshot(env, { signal } = {}) {
  if (!env.FOGD_ADMIN_PASSWORD) throw new Error('Set FOGD_ADMIN_PASSWORD for administrator inspection');
  let response;
  try {
    response = await controllerGet(serverOrigin(env), '/v1/admin', `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER || 'admin'}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`, { signal });
  } catch { throw new Error('Cannot read controller state; check its endpoint, TLS trust, and availability'); }
  if (!response.ok) {
    await discardResponse(response);
    if ([401, 403].includes(response.status)) throw new Error('Administrator authentication was refused; check the selected installation credentials');
    throw new Error(`Controller state is unavailable (HTTP ${response.status}); inspect controller availability and storage before acting`);
  }
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await discardResponse(response); throw new Error('Controller did not return JSON state; check the selected endpoint');
  }
  return boundedJson(response, { limit: 4 * 1024 ** 2,
    invalid: 'Controller returned unreadable JSON state; private response contents are withheld',
    interrupted: 'Controller state read was interrupted or timed out; inspect availability before acting',
    oversized: 'Controller state exceeded the 4 MiB inspection limit; use the authenticated admin interface for this installation' });
}
