import { configEnv, serverOrigin } from '../local.mjs';
import { readAdminSnapshot } from '../inspect-command.mjs';
import { boundedJson, discardResponse } from '../client-http.mjs';

const uncertainMessage = 'Artifact pin update is uncertain; inspect a fresh artifact plan before retrying';
const uncertain = () => new Error(uncertainMessage);

function parse(args) {
  const [action, id, digest] = args;
  if (args.length !== 3 || !['keep', 'unkeep'].includes(action)) throw new Error('Usage: fogd admin artifacts keep|unkeep ID SHA');
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Artifact pin changes require a canonical deployment ID and SHA256 digest');
  return { action, id, digest };
}

export async function artifactPinCommand(args) {
  const command = parse(args), env = await configEnv(), state = await readAdminSnapshot(env);
  if (typeof state?.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(state.csrf)) throw new Error('Controller did not return a valid mutation token; artifact pin update was not sent');
  const response = await update(env, state.csrf, command);
  await checkUpdate(response);
  const value = await boundedJson(response, { limit: 4096, invalid: uncertainMessage });
  if (value?.schema !== 1 || value.id !== command.id || value.digest !== command.digest || value.kept !== (command.action === 'keep')) throw uncertain();
  console.log(JSON.stringify({ schema: 1, id: value.id, digest: value.digest, kept: value.kept }, null, 2));
}

async function update(env, csrf, { action, id, digest }) {
  const authorization = `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER || 'admin'}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`;
  try {
    return await fetch(`${serverOrigin(env)}/v1/admin/artifacts/${id}/${action}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-Fogd-CSRF': csrf }, body: JSON.stringify({ digest }) });
  } catch { throw uncertain(); }
}

async function checkUpdate(response) {
  if (!response.ok) {
    await discardResponse(response);
    if (response.status >= 500) throw uncertain();
    if ([401, 403].includes(response.status)) throw new Error('Artifact pin authorization was refused; inspect owner credentials and retry explicitly');
    if (response.status === 404) throw new Error('Controller does not provide artifact pins; use a runtime that supports this command');
    throw new Error(`Controller refused artifact pin update (HTTP ${response.status}); inspect the current artifact plan`);
  }
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await discardResponse(response); throw uncertain();
  }
}
