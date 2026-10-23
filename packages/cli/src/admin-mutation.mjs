import { configEnv, serverOrigin } from './local.mjs';
import { readAdminSnapshot } from './inspect-command.mjs';
import { boundedJson, discardResponse } from './client-http.mjs';

const message = operation => `${operation.label} is uncertain; ${operation.advice}`;
export const uncertainAdminMutation = operation => new Error(message(operation));

export async function mutateAdmin(operation, path, input) {
  const env = await configEnv(), state = await readAdminSnapshot(env);
  if (typeof state?.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(state.csrf)) throw new Error(`Controller did not return a valid mutation token; ${operation.noun} was not sent`);
  const authorization = `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER || 'admin'}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`;
  let response;
  try {
    response = await fetch(`${serverOrigin(env)}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(operation.timeout),
      headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-Fogd-CSRF': state.csrf }, body: JSON.stringify(input) });
  } catch { throw uncertainAdminMutation(operation); }
  await checkUpdate(response, operation);
  return boundedJson(response, { limit: operation.limit, invalid: message(operation) });
}

async function checkUpdate(response, operation) {
  if (!response.ok) {
    await discardResponse(response);
    if (response.status >= 500) throw uncertainAdminMutation(operation);
    if ([401, 403].includes(response.status)) throw new Error(`${operation.subject} authorization was refused; inspect owner credentials and retry explicitly`);
    if (response.status === 404) throw new Error(`Controller does not provide ${operation.feature}; use a runtime that supports this command`);
    if (operation.uncertainRefusal) throw uncertainAdminMutation(operation);
    throw new Error(`Controller refused ${operation.noun} (HTTP ${response.status}); ${operation.refusal}`);
  }
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await discardResponse(response); throw uncertainAdminMutation(operation);
  }
}
