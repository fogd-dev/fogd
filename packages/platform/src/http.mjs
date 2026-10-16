import { equal } from './security.mjs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { manifest, MAX_UPLOAD } from '@fogd/runtime/manifest';
import { adminDeployment, adminState } from './admin-view.mjs';
import { checkMutation, secretRequest } from './admin-secrets.mjs';
import { deploymentStatus } from './deployment-status.mjs';

const revision = (d, controller) => (d.requiredSecrets || []).length ? d.secretRevision || controller.secrets.index[d.app]?.revision || null : null;
const html = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
async function body(request, limit = MAX_UPLOAD * 1.4) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('JSON content type required');
  let size = 0; const parts = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Upload too large');
    parts.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(parts).toString()); }
  catch { throw new Error('Invalid JSON body'); }
}
async function deploymentRequest(request, url, controller, deployToken, send) {
  const submitting = url.pathname === '/v1/deployments' && request.method === 'POST';
  const match = request.method === 'GET' && /^\/v1\/deployments\/([a-f0-9-]{36})$/.exec(url.pathname);
  if (!submitting && !match) return false;
  if (!equal(request.headers.authorization, `Bearer ${deployToken}`)) {
    send(401, { error: 'Unauthorized' });
  } else if (submitting) {
    send(201, await controller.submit(await body(request), 'team-token'));
  } else {
    const release = controller.state.deployments[match[1]];
    if (release?.submitter !== 'team-token') send(404, { error: 'Deployment not found' });
    else send(200, deploymentStatus(release));
  }
  return true;
}
export function server(controller, credentials) {
  const csrf = randomBytes(32).toString('hex');
  const basic = `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`;
  return createServer({ requestTimeout: 300000, maxHeaderSize: 16384 }, async (request, response) => {
    const send = (status, value, type = 'application/json') => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      response.end(type === 'application/json' ? JSON.stringify(value) : value);
    };
    try {
      const url = new URL(request.url, 'http://controller');
      if (url.pathname === '/internal/route' && request.method === 'GET') {
        if (!equal(request.headers.authorization, `Bearer ${credentials.gateway}`)) return send(401, { error: 'Unauthorized' });
        return send(200, controller.route(url.searchParams.get('host') || ''));
      }
      if (await deploymentRequest(request, url, controller, credentials.deploy, send)) return;
      if (!equal(request.headers.authorization, basic)) {
        response.setHeader('WWW-Authenticate', 'Basic realm="fogd admin", charset="UTF-8"');
        return send(401, { error: 'Admin authentication required' });
      }
      if (request.method === 'GET' && url.pathname === '/v1/admin') return send(200, { csrf, ...adminState(controller) });
      if (await secretRequest(request, url, controller, csrf, body, send)) return;
      const match = /^\/v1\/deployments\/([a-f0-9-]{36})\/(approve|reject|artifact)$/.exec(url.pathname);
      if (match && match[2] === 'artifact' && request.method === 'GET') {
        const release = controller.state.deployments[match[1]];
        if (!release) return send(404, { error: 'Not found' });
        return send(200, await manifest(controller.artifact(release.id), release));
      }
      if (match && request.method === 'POST' && ['approve', 'reject'].includes(match[2])) {
        try { checkMutation(request, csrf); }
        catch (error) { return send(403, { error: error.message }); }
        const input = await body(request);
        return send(200, adminDeployment(await controller.mutate(match[1], input.digest, match[2], input.secretRevision)));
      }
      if (request.method === 'GET' && url.pathname === '/') {
        const apps = Object.entries(controller.state.apps).map(([name, app]) => `<p><strong>${html(name)}</strong>: ${html(app.route)} (${html(app.slot)}) ${html(app.reason || '')}</p>`).join('');
        const rows = Object.values(controller.state.deployments).reverse().map(d => `<article><h2>${html(d.app)} — ${html(d.status)}</h2><p>Submitted by ${html(d.submitter)} at ${html(d.submittedAt)}</p><code>${html(d.digest)}</code><p>Secret revision: ${html(revision(d, controller) || 'none')}${d.secretRevision ? ' (pinned for retry)' : ''}</p><p>${html(d.step)} ${html(d.error || '')}</p><details><summary>Resources and migrations</summary><pre>${html(JSON.stringify({ requiredSecrets: d.requiredSecrets || [], secretRevision: revision(d, controller), resourceChanges: d.resourceChanges, resources: d.resources, migrations: d.migrations }, null, 2))}</pre></details><p><a href="/v1/deployments/${d.id}/artifact">Review full artifact manifest</a></p>${['pending', 'failed'].includes(d.status) ? ['approve', 'reject'].map(action => `<button data-id="${d.id}" data-digest="${d.digest}" data-action="${action}" data-secret-revision="${html(revision(d, controller) || '')}">${action === 'approve' && d.status === 'failed' ? 'Retry approval' : action}</button>`).join(' ') : ''}</article>`).join('');
        return send(200, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>fogd approvals</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:16px;background:#f7f8fa;color:#18212f}article{background:white;border:1px solid #ccd3dc;padding:20px;margin:20px 0;border-radius:8px}code,pre{overflow-wrap:anywhere;white-space:pre-wrap}button{padding:10px 20px;cursor:pointer}h1{font-size:32px}</style><h1>fogd deploy approvals</h1><p>Review the exact artifact before approving. Activation may take a few minutes and pauses the app. Only trusted application code is supported.</p>${apps}${rows || '<p>No submissions yet. Run fogd deploy in a Void app.</p>'}<script>for(const b of document.querySelectorAll('button'))b.onclick=async()=>{b.disabled=true;try{const r=await fetch('/v1/deployments/'+b.dataset.id+'/'+b.dataset.action,{method:'POST',headers:{'Content-Type':'application/json','X-Fogd-CSRF':${JSON.stringify(csrf)}},body:JSON.stringify({digest:b.dataset.digest,secretRevision:b.dataset.secretRevision||null})});const x=await r.json();if(!r.ok)throw Error(x.error);location.reload()}catch(e){alert(e.message);b.disabled=false}}</script></html>`, 'text/html; charset=utf-8');
      }
      send(404, { error: 'Not found' });
    } catch (error) { send(400, { error: error.message }); }
  });
}
