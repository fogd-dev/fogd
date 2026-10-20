import { dispatchFor } from './cron-activation.mjs';
import { checkMutation } from './admin-secrets.mjs';

function resumable(controller, app) {
  const active = controller.state.deployments[app.active];
  return Boolean(active?.status === 'active' && app.route === 'active' && !app.quarantined && !app.retirement && !app.uncertain && !app.dispatch.hold && app.cronBootstrap?.phase === 'application' && active.version === app.dispatch.version);
}

export function dispatchView(controller, name) {
  const app = controller.state.apps[name];
  if (!app?.dispatch) throw new Error('App has no scheduled dispatch journal');
  const { version: _version, ...journal } = app.dispatch;
  const active = controller.state.deployments[app.active];
  const approval = controller.state.deployments[journal.hold || app.active];
  const operationAllowed = Boolean(controller.backend.crons && !app.retirement && !app.quarantined && app.cronBootstrap.phase !== 'pending');
  return { app: name, ...journal, effective: journal.hold ? 'paused' : journal.desired,
    bootstrap: app.cronBootstrap.phase, recoveryError: app.dispatchRecoveryError || null,
    active: active ? { deployment: active.id, digest: active.digest } : null,
    approval: approval ? { deployment: approval.id, digest: approval.digest, status: approval.status, step: approval.step } : null,
    applicationOutcomes: 'not-observed', operationAllowed, resumeAllowed: operationAllowed && resumable(controller, app) };
}

function dispatchTarget(controller, name) {
  const app = controller.state.apps[name];
  if (!app?.dispatch) throw new Error('App has no scheduled dispatch journal');
  if (app.retirement || app.quarantined) throw new Error('Scheduled fleet is retired or quarantined');
  if (!controller.backend.crons) throw new Error('Cron runtime transport is unavailable');
  if (app.cronBootstrap.phase === 'pending') throw new Error('Retry bootstrap activation before operating scheduled dispatch');
  const slot = controller.slots.find(value => value.id === app.slot);
  if (!slot) throw new Error('Scheduled fleet is missing');
  return { app, slot };
}

export async function operateDispatch(controller, name, action, input = {}) {
  if (!['observe', 'pause', 'resume'].includes(action)) throw new Error('Invalid dispatch action');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Dispatch input must be a JSON object');
  const { app, slot } = dispatchTarget(controller, name);
  if (action === 'resume') {
    if (!resumable(controller, app)) throw new Error('Resume requires a completed activation with no hold or uncertain migration');
    const active = controller.state.deployments[app.active];
    if (input.deployment !== active.id || input.digest !== active.digest) throw new Error('Active deployment/digest changed; inspect dispatch before resuming');
  }
  try {
    await dispatchFor(controller, app, slot)[action]();
    if (action === 'pause' && app.dispatchRecoveryError) { delete app.dispatchRecoveryError; await controller.save(); }
  } catch (cause) {
    controller.assertStorage();
    const error = new Error('Scheduled operation could not be confirmed; inspect recorded dispatch and refresh status before retrying', { cause });
    error.code = 'CRON_OPERATION_UNCONFIRMED'; throw error;
  }
  return dispatchView(controller, name);
}

// Runtime info may materialize a cell. GET is recorded state only; observe is
// an admin mutation, serialized with approval and protected against CSRF.
export async function dispatchRequest(request, url, controller, csrf, body, send) {
  const match = /^\/v1\/apps\/([a-z0-9-]+)\/dispatch(?:\/(observe|pause|resume))?$/.exec(url.pathname);
  if (!match) return false;
  if (request.method === 'GET' && !match[2]) { send(200, dispatchView(controller, match[1])); return true; }
  if (request.method !== 'POST' || !match[2]) return false;
  try { checkMutation(request, csrf); }
  catch (error) { send(403, { error: error.message }); return true; }
  const input = await body(request, 4096);
  send(200, await controller.exclusive(() => operateDispatch(controller, match[1], match[2], input)));
  return true;
}

export function dispatchHTML(controller, html, csrf) {
  const cards = Object.keys(controller.state.apps).filter(name => controller.state.apps[name].dispatch).map(name => {
    const state = dispatchView(controller, name);
    const actions = state.operationAllowed ? ['observe', 'pause', ...(state.resumeAllowed ? ['resume'] : [])] : [];
    const buttons = actions.map(action => `<button data-dispatch="${action}" data-app="${html(name)}" data-deployment="${html(state.active?.deployment || '')}" data-digest="${html(state.active?.digest || '')}">${action === 'observe' ? 'Refresh runtime status' : action}</button>`).join(' ');
    return `<article><h2>${html(name)} scheduled dispatch</h2><p>Desired: ${html(state.desired)}. Effective intent: ${html(state.effective)}. Recorded observation: ${html(state.observed)} at ${html(state.observedAt || 'unknown')}.</p><p>Active deployment: ${html(state.active?.deployment || 'none')}. Digest: <code>${html(state.active?.digest || 'none')}</code>.</p><p>Activation hold: ${html(state.hold || 'none')}. Unconfirmed operation: ${html(state.operation || 'none')}.</p><p>Approval: ${html(state.approval?.status || 'none')} at ${html(state.approval?.step || 'unknown')}. ${html(state.recoveryError || '')}</p>${buttons}</article>`;
  }).join('');
  if (!cards) return '';
  return `<section><h2>Scheduled dispatch</h2><p>Status is a recorded runtime observation. Pause does not drain running callbacks or waitUntil work. Operator pause persists across approvals. Resume requires the displayed active artifact to remain current. Check the application for saved results and job failures.</p>${cards}</section><script>for(const b of document.querySelectorAll('button[data-dispatch]'))b.onclick=async()=>{b.disabled=true;try{const r=await fetch('/v1/apps/'+encodeURIComponent(b.dataset.app)+'/dispatch/'+b.dataset.dispatch,{method:'POST',headers:{'Content-Type':'application/json','X-Fogd-CSRF':${JSON.stringify(csrf)}},body:JSON.stringify({deployment:b.dataset.deployment,digest:b.dataset.digest})});const x=await r.json();if(!r.ok)throw Error(x.error);location.reload()}catch(e){alert(e.message);b.disabled=false}}</script>`;
}
