import { configEnv, serverOrigin } from '../local.mjs';
import { readAdminSnapshot } from '../inspect-command.mjs';
import { boundedJson, discardResponse } from '../client-http.mjs';

const operations = {
  pin: { label: 'Artifact pin update', subject: 'Artifact pin', timeout: 15000, noun: 'artifact pin update', feature: 'artifact pins', limit: 4096, advice: 'inspect a fresh artifact plan before retrying' },
  prune: { label: 'Artifact prune operation', subject: 'Artifact prune', timeout: 900000, noun: 'artifact prune operation', feature: 'artifact pruning', limit: 4 * 1024 ** 2, advice: 'inspect artifact prune status before deciding whether to resume' },
};
const message = kind => `${operations[kind].label} is uncertain; ${operations[kind].advice}`;
export const uncertainArtifactMutation = kind => new Error(message(kind));

export async function mutateArtifact(kind, path, input) {
  if (!Object.hasOwn(operations, kind)) throw new Error('Unknown artifact mutation kind');
  const operation = operations[kind], env = await configEnv(), state = await readAdminSnapshot(env);
  if (typeof state?.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(state.csrf)) throw new Error(`Controller did not return a valid mutation token; ${operation.noun} was not sent`);
  const authorization = `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER || 'admin'}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`;
  let response;
  try {
    response = await fetch(`${serverOrigin(env)}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(operation.timeout),
      headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-Fogd-CSRF': state.csrf }, body: JSON.stringify(input) });
  } catch { throw uncertainArtifactMutation(kind); }
  await checkUpdate(response, kind);
  return boundedJson(response, { limit: operation.limit, invalid: message(kind) });
}

async function checkUpdate(response, kind) {
  if (!response.ok) {
    await discardResponse(response);
    if (response.status >= 500) throw uncertainArtifactMutation(kind);
    if ([401, 403].includes(response.status)) throw new Error(`${operations[kind].subject} authorization was refused; inspect owner credentials and retry explicitly`);
    if (response.status === 404) throw new Error(`Controller does not provide ${operations[kind].feature}; use a runtime that supports this command`);
    throw new Error(`Controller refused ${operations[kind].noun} (HTTP ${response.status}); inspect the current artifact plan`);
  }
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await discardResponse(response); throw uncertainArtifactMutation(kind);
  }
}
