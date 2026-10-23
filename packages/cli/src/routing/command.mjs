import { appName } from '@fogd/runtime/artifact';
import { configEnv, serverOrigin } from '../local.mjs';
import { controllerGet, boundedJson, discardResponse } from '../client-http.mjs';
import { mutateAdmin, uncertainAdminMutation } from '../admin-mutation.mjs';
import { routeIntent, routeSelection, routingView } from './view.mjs';

const operation = { label: 'HTTP routing decision', subject: 'HTTP routing', noun: 'HTTP routing decision', feature: 'durable HTTP routing controls',
  timeout: 900000, limit: 65536, uncertainRefusal: true, advice: 'inspect fresh routing status before deciding the next action' };
const usage = 'Usage: fogd admin routing APP [status | pause|resume ID SHA | reconcile|withhold-pending ID SHA INTENT]';
function parse(args) {
  const [app, action = 'status', deployment, digest, intent] = args;
  appName(app);
  if (action === 'status' && args.length <= 2) return { app, action };
  const pending = ['reconcile', 'withhold-pending'].includes(action);
  if ((!pending && !['pause', 'resume'].includes(action)) || args.length !== (pending ? 5 : 4)) throw new Error(usage);
  let selected;
  try { selected = routeSelection(deployment, digest); if (pending) routeIntent(intent, true); }
  catch { throw new Error('Routing decisions require a canonical deployment ID, SHA256 digest and, for pending work, its exact active publication intent'); }
  return { app, action, input: { ...selected, ...(pending ? { intent } : {}) } };
}
async function status(app) {
  const env = await configEnv();
  if (!env.FOGD_ADMIN_PASSWORD) throw new Error('Set FOGD_ADMIN_PASSWORD for administrator routing inspection');
  let response;
  try { response = await controllerGet(serverOrigin(env), `/v1/apps/${app}/routing`, `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER || 'admin'}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`); }
  catch { throw new Error('Cannot read HTTP routing state; check endpoint, TLS trust and controller availability'); }
  if (!response.ok) {
    await discardResponse(response);
    if (response.status === 404) throw new Error('Controller does not provide durable HTTP routing controls; use a runtime that supports this command');
    throw new Error(`HTTP routing inspection was refused or unavailable (HTTP ${response.status})`);
  }
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await discardResponse(response); throw new Error('Controller did not return JSON routing state');
  }
  return routingView(await boundedJson(response, { limit: operation.limit, invalid: 'HTTP routing state is unreadable, oversized or interrupted; private contents are withheld' }), app);
}
export async function routingCommand(args) {
  const command = parse(args);
  if (command.action === 'status') { console.log(JSON.stringify(await status(command.app), null, 2)); return; }
  const value = await mutateAdmin(operation, `/v1/apps/${command.app}/routing/${command.action}`, command.input);
  let view;
  try {
    view = routingView(value, command.app);
    const serving = ['resume', 'reconcile'].includes(command.action);
    if (view.state !== (serving ? 'active' : 'withheld') || view.pending !== null ||
      (serving && (view.startupBlocked || view.active.deployment !== command.input.deployment || view.active.digest !== command.input.digest))) throw new Error();
  } catch { throw uncertainAdminMutation(operation); }
  console.log(JSON.stringify(view, null, 2));
}
