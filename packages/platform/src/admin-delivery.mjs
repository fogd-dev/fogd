import { deliveryFor } from './queue-activation.mjs';
import { checkMutation } from './admin-secrets.mjs';

function resumable(controller, app) {
  const active = controller.state.deployments[app.active];
  return Boolean(active?.status === 'active' && app.route === 'active' && !app.quarantined && !app.retirement && !app.uncertain && !app.delivery.hold && app.queueBootstrap?.phase === 'application' && active.version === app.delivery.version);
}

export function deliveryView(controller, name) {
  const app = controller.state.apps[name];
  if (!app?.delivery) throw new Error('App has no queue delivery journal');
  const { version: _version, ...journal } = app.delivery;
  const active = controller.state.deployments[app.active];
  return { app: name, ...journal, effective: journal.hold ? 'paused' : journal.desired,
    bootstrap: app.queueBootstrap.phase, recoveryError: app.deliveryRecoveryError || null,
    active: active ? { deployment: active.id, digest: active.digest } : null,
    operationAllowed: !app.retirement && !app.quarantined && app.queueBootstrap.phase !== 'pending',
    resumeAllowed: resumable(controller, app) };
}

function deliveryTarget(controller, name) {
  const app = controller.state.apps[name];
  if (!app?.delivery) throw new Error('App has no queue delivery journal');
  if (app.retirement || app.quarantined) throw new Error('Queue fleet is retired or quarantined');
  if (app.queueBootstrap.phase === 'pending') throw new Error('Retry bootstrap activation before operating delivery');
  const slot = controller.slots.find(value => value.id === app.slot);
  if (!slot) throw new Error('Queue fleet is missing');
  return { app, slot };
}

export async function operateDelivery(controller, name, action, input = {}) {
  const { app, slot } = deliveryTarget(controller, name);
  if (!['observe', 'pause', 'resume'].includes(action)) throw new Error('Invalid delivery action');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Delivery input must be a JSON object');
  if (action === 'resume') {
    if (!resumable(controller, app)) throw new Error('Resume requires a completed activation with no hold or uncertain migration');
    const active = controller.state.deployments[app.active];
    if (input.deployment !== active.id || input.digest !== active.digest) throw new Error('Active deployment/digest changed; inspect delivery before resuming');
  }
  try {
    await deliveryFor(controller, app, slot)[action]();
    if (action === 'pause' && app.deliveryRecoveryError) { delete app.deliveryRecoveryError; await controller.save(); }
  }
  catch (cause) {
    controller.assertStorage();
    const error = new Error('Queue operation could not be confirmed; inspect recorded delivery and refresh status before retrying', { cause });
    error.code = 'QUEUE_OPERATION_UNCONFIRMED'; throw error;
  }
  return deliveryView(controller, name);
}

// GET returns recorded state only. Upstream queue info can instantiate a cell,
// so refreshing observations is an authenticated, CSRF-protected POST.
export async function deliveryRequest(request, url, controller, csrf, body, send) {
  const match = /^\/v1\/apps\/([a-z0-9-]+)\/delivery(?:\/(observe|pause|resume))?$/.exec(url.pathname);
  if (!match) return false;
  if (request.method === 'GET' && !match[2]) {
    send(200, deliveryView(controller, match[1])); return true;
  }
  if (request.method !== 'POST' || !match[2]) return false;
  try { checkMutation(request, csrf); }
  catch (error) { send(403, { error: error.message }); return true; }
  const input = await body(request, 4096);
  send(200, await controller.exclusive(() => operateDelivery(controller, match[1], match[2], input)));
  return true;
}

export function deliveryHTML(controller, html, csrf) {
  const cards = Object.keys(controller.state.apps).filter(name => controller.state.apps[name].delivery).map(name => {
    const state = deliveryView(controller, name);
    const buttons = (state.operationAllowed ? ['observe', 'pause', ...(state.resumeAllowed ? ['resume'] : [])] : []).map(action => `<button data-delivery="${action}" data-app="${html(name)}" data-deployment="${html(state.active?.deployment || '')}" data-digest="${html(state.active?.digest || '')}">${action === 'observe' ? 'Refresh status' : action}</button>`).join(' ');
    return `<article><h2>${html(name)} queue</h2><p>Desired: ${html(state.desired)}. Effective intent: ${html(state.effective)}. Recorded observation: ${html(state.observed)} at ${html(state.observedAt || 'unknown')}.</p><p>Active deployment: ${html(state.active?.deployment || 'none')}. Digest: <code>${html(state.active?.digest || 'none')}</code>.</p><p>Activation hold: ${html(state.hold || 'none')}. Unconfirmed operation: ${html(state.operation || 'none')}.</p><p>${html(state.recoveryError || '')}</p>${buttons}</article>`;
  }).join('');
  if (!cards) return '';
  return `<section><h2>Queue delivery</h2><p>Status is a recorded observation. Pause does not drain running handlers. Operator pause persists across successful approvals. Refresh contacts the runtime; resume requires the displayed active artifact to remain current.</p>${cards}</section><script>for(const b of document.querySelectorAll('button[data-delivery]'))b.onclick=async()=>{b.disabled=true;try{const r=await fetch('/v1/apps/'+encodeURIComponent(b.dataset.app)+'/delivery/'+b.dataset.delivery,{method:'POST',headers:{'Content-Type':'application/json','X-Fogd-CSRF':${JSON.stringify(csrf)}},body:JSON.stringify({deployment:b.dataset.deployment,digest:b.dataset.digest})});const x=await r.json();if(!r.ok)throw Error(x.error);location.reload()}catch(e){alert(e.message);b.disabled=false}}</script>`;
}
