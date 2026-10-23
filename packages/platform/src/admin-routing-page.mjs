import { html } from './admin-html.mjs';
import { checkMutation } from './admin-secrets.mjs';
import { applicationWithheld } from './route-publication.mjs';

const type = 'text/html; charset=utf-8';
const actions = { pause: 'Pause HTTP', resume: 'Verify and resume HTTP', reconcile: 'Verify and reconcile', 'withhold-pending': 'Withhold pending HTTP' };
const pendingAction = action => ['reconcile', 'withhold-pending'].includes(action);
export const routingPageLink = controller => controller.routes.durable ? '<p><a href="/routing">Inspect and control HTTP routing</a></p>' : '';

function document(content, recoveryOnly) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HTTP routing · fogd</title><style>
body{font:16px/1.5 system-ui,sans-serif;color:#18212f;background:#f7f8fa;max-width:960px;margin:40px auto;padding:0 20px}h1{font-size:32px;margin-bottom:8px}h2{margin:0}article{background:white;border:1px solid #ccd3dc;border-radius:8px;padding:24px;margin:24px 0}code{font-size:14px;overflow-wrap:anywhere;white-space:pre-wrap}dl{display:grid;grid-template-columns:150px 1fr;gap:8px 16px}dt{font-weight:600}dd{margin:0;min-width:0}.notice{padding:16px;border-left:4px solid #b06c00;background:#fff5df}.unavailable{border-color:#bd3b30}.state{font-weight:600}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:20px}button{font:inherit;cursor:pointer;padding:10px 16px;border:1px solid #344054;border-radius:5px;background:white;color:#18212f}button:focus-visible,a:focus-visible{outline:3px solid #2768ca;outline-offset:3px}a{color:#1756a9}small{color:#475467}@media(max-width:600px){body{margin:24px auto}article{padding:16px}dl{grid-template-columns:1fr;gap:4px}dd{margin-bottom:12px}}
</style><header><small>fogd operator</small><h1>HTTP routing</h1>${recoveryOnly ? '<p class="notice"><strong>Recovery only. Keep ingress stopped.</strong> Resolve the pending publication, then complete the ordered startup checks. Resume is unavailable here.</p>' : '<p><a href="/">Back to deployment approvals</a></p>'}<p>Inspect authority for new HTTP requests. This does not report application health, drain existing sessions, or pause background work.</p></header><main>${content}</main></html>`;
}

function selection(controller, name) {
  const app = controller.state.apps[name], release = controller.state.deployments[app.active];
  return release?.app === name && release.status === 'active' && release.step === 'complete' ? { id: release.id, digest: release.digest } : null;
}
function reference(value) {
  return value ? `<code>${html(value.id || value.deployment)}</code><br><code>${html(value.digest)}</code>` : 'None';
}
function form(name, action, selected, intent, csrf, describedBy) {
  const fields = { csrf, deployment: selected.id, digest: selected.digest, ...(intent ? { intent } : {}) };
  return `<form method="post" action="/routing/${html(encodeURIComponent(name))}/${action}">${Object.entries(fields).map(([key, value]) => `<input type="hidden" name="${key}" value="${html(value)}">`).join('')}<button type="submit" aria-label="${html(actions[action] + ' for ' + name)}" aria-describedby="${describedBy}">${actions[action]}</button></form>`;
}
function controls(controller, name, view, csrf, recoveryOnly, id) {
  const app = controller.state.apps[name], pending = view.pending;
  if (pending) {
    if (pending.app !== name || pending.kind !== 'active' || !pending.approval) return '<p>Resolve the pending publication before another routing decision.</p>';
    return `<div id="${id}"><p><strong>Selected pending approval</strong><br>${reference(pending.approval)}<br>Intent: <code>${html(pending.intent)}</code></p></div><div class="actions">${['reconcile', 'withhold-pending'].map(action => form(name, action, pending.approval, pending.intent, csrf, id)).join('')}</div>`;
  }
  const selected = selection(controller, name);
  if (!selected) return '<p>No completed approval is available for an HTTP decision. Review deployment approvals.</p>';
  const allowed = [];
  if (view.state === 'active') allowed.push('pause');
  const held = view.hold;
  const resumable = !recoveryOnly && !view.startupBlocked && !applicationWithheld({ ...app, route: 'active' }) && (!held || held.id === selected.id);
  if (view.state === 'withheld' && resumable) allowed.push('resume');
  return `<div id="${id}"><p><strong>Selected completed approval</strong><br>${reference(selected)}</p></div>${allowed.length ? `<div class="actions">${allowed.map(action => form(name, action, selected, null, csrf, id)).join('')}</div>` : '<p>Routing is held. Resolve activation, recovery or startup requirements before resuming.</p>'}`;
}
async function page(controller, csrf, recoveryOnly) {
  const cards = [];
  for (const [name, app] of Object.entries(controller.state.apps)) {
    if (app.retirement) continue;
    let view;
    try { view = await controller.routes.view(name); }
    catch { cards.push(`<article class="unavailable"><h2>${html(name)}</h2><p role="status">Routing status is unavailable. No decision is offered. Inspect controller availability and storage before acting.</p></article>`); continue; }
    cards.push(`<article><h2>${html(name)}</h2><dl><dt>Authority</dt><dd class="state">${html(view.state)}</dd><dt>Revision</dt><dd><code>${html(view.revision)}</code></dd><dt>Active approval</dt><dd>${reference(view.active)}</dd><dt>Approval hold</dt><dd>${reference(view.hold)}</dd><dt>Startup</dt><dd>${recoveryOnly ? 'Recovery service — keep ingress stopped' : view.startupBlocked ? 'Blocked — keep ingress stopped' : 'Not blocked in this observation'}</dd><dt>Pending publication</dt><dd>${view.pending ? `${html(view.pending.app || 'Installation')} · <code>${html(view.pending.intent)}</code>` : 'None'}</dd></dl>${controls(controller, name, view, csrf, recoveryOnly, `selection-${cards.length}`)}</article>`);
  }
  return document(cards.join('') || '<p>No live applications have routing state yet.</p>', recoveryOnly);
}

async function formInput(request, action, csrf) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') throw new Error('Routing form required');
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 4096) throw new Error('Routing form is too large'); chunks.push(chunk); }
  const values = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  const expected = ['csrf', 'deployment', 'digest', ...(pendingAction(action) ? ['intent'] : [])];
  if ([...values].length !== expected.length || expected.some(key => values.getAll(key).length !== 1)) throw new Error('Routing form fields are invalid');
  checkMutation({ headers: { ...request.headers, 'x-fogd-csrf': values.get('csrf') } }, csrf);
  return { deployment: values.get('deployment'), digest: values.get('digest'), ...(pendingAction(action) ? { intent: values.get('intent') } : {}) };
}
export async function routingPageRequest(request, url, controller, csrf, send, recoveryOnly = false) {
  if (!controller.routes.durable) return false;
  if (request.method === 'GET' && (url.pathname === '/routing' || recoveryOnly && url.pathname === '/')) {
    try { send(200, await controller.exclusive(() => page(controller, csrf, recoveryOnly)), type); }
    catch { send(503, document('<p role="alert">Routing status is unavailable. Inspect controller availability and storage before acting.</p>', recoveryOnly), type); }
    return true;
  }
  const match = /^\/routing\/([a-z0-9-]+)\/(pause|resume|reconcile|withhold-pending)$/.exec(url.pathname);
  if (request.method !== 'POST' || !match) return false;
  if (recoveryOnly && match[2] === 'resume') { send(503, document('<p role="alert">Resume is unavailable during routing recovery. Keep ingress stopped.</p><a href="/routing">Inspect routing status</a>', true), type); return true; }
  let input;
  try { input = await formInput(request, match[2], csrf); }
  catch { send(403, document('<p role="alert">Routing form was refused. Refresh the page and review the selected approval.</p><a href="/routing">Inspect routing status</a>', recoveryOnly), type); return true; }
  try { await controller.decideRoute(match[1], match[2], input); }
  catch { send(503, document('<p role="alert">HTTP routing outcome is uncertain. Do not assume a pause succeeded. Inspect current routing status before another decision.</p><a href="/routing">Inspect routing status</a>', recoveryOnly), type); return true; }
  send(303, '<a href="/routing">Inspect routing status</a>', type, { Location: '/routing' });
  return true;
}
