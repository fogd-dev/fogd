import { archiveRecoveryRequest } from './admin-archive-recovery.mjs';
import { selectedSecretRevision } from './decision-history.mjs';
import { artifactReviewRequest } from './admin-review.mjs';
import { decisionHistoryRequest } from './admin-decisions.mjs';
import { html } from './admin-html.mjs';
import { routingPageRequest, routingPageLink } from './admin-routing-page.mjs';
import { artifactRequest, artifactManifest } from './admin-artifacts.mjs';
import { artifactPruneRequest } from './admin-artifact-pruning.mjs';
import { ingressRequest } from './admin-ingress.mjs';
import { deliveryRequest, deliveryHTML } from './admin-delivery.mjs';
import { routingRecoveryRequest, assertRoutingServiceMode } from './admin-routing-recovery.mjs';
import { routingRequest } from './admin-routing.mjs';
import { dispatchRequest, dispatchHTML } from './admin-dispatch.mjs';
import { capacityHTML } from './admin-capacity.mjs';
import { equal } from './security.mjs';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import { MAX_UPLOAD } from '@fogd/runtime/manifest';
import { adminDeployment, adminState } from './admin-view.mjs';
import { checkMutation, secretRequest } from './admin-secrets.mjs';
import { deploymentHandler } from './deployment-http.mjs';
import { credentialRequest } from './admin-credentials.mjs';

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
export function server(controller, credentials, { maxUploads = 2, role = 'public', tls = null, recoveryOnly = false } = {}) {
  assertRoutingServiceMode(controller, recoveryOnly);
  if (recoveryOnly) controller.restrictRoutingService();
  const deploymentRequest = deploymentHandler(controller, credentials.deploy, body, maxUploads);
  const csrf = randomBytes(32).toString('hex');
  const basic = `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}`;
  const create = tls ? createSecureServer : createServer;
  return create({ ...tls, requestTimeout: 300000, maxHeaderSize: 16384 }, async (request, response) => {
    const send = (status, value, type = 'application/json', extra = {}) => {
      response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", ...extra });
      response.end(type === 'application/json' ? JSON.stringify(value) : value);
    };
    try {
      const url = new URL(request.url, 'http://controller');
      if (role === 'internal' && controller.routes.durable) return send(404, { error: 'Not found' });
      if (role === 'internal' && url.pathname === '/internal/route' && request.method === 'GET') {
        if (!equal(request.headers.authorization, `Bearer ${credentials.gateway}`)) return send(401, { error: 'Unauthorized' });
        return send(200, controller.route(url.searchParams.get('host') || ''));
      }
      if (role === 'internal' || url.pathname.startsWith('/internal/')) return send(404, { error: 'Not found' });
      if (!recoveryOnly && await deploymentRequest(request, url, send)) return;
      if (!equal(request.headers.authorization, basic)) {
        response.setHeader('WWW-Authenticate', 'Basic realm="fogd admin", charset="UTF-8"');
        return send(401, { error: 'Admin authentication required' });
      }
      controller.assertStorage();
      if (await routingPageRequest(request, url, controller, csrf, send, recoveryOnly)) return;
      if (recoveryOnly) return await routingRecoveryRequest(request, url, controller, csrf, body, send);
      if (request.method === 'GET' && url.pathname === '/v1/admin') return send(200, { csrf, ...adminState(controller) });
      if (await archiveRecoveryRequest(request, url, controller, csrf, body, send, { kind: 'basic', name: credentials.user })) return;
      if (await artifactReviewRequest(request, url, controller, csrf, send)) return;
      if (await decisionHistoryRequest(request, url, controller, send)) return;
      if (await artifactRequest(request, url, controller, csrf, body, send)) return;
      if (await artifactPruneRequest(request, url, controller, csrf, body, send)) return;
      if (await ingressRequest(request, url, controller, csrf, body, send)) return;
      if (await credentialRequest(request, url, controller, csrf, body, send)) return;
      if (await deliveryRequest(request, url, controller, csrf, body, send)) return;
      if (await dispatchRequest(request, url, controller, csrf, body, send)) return;
      if (await routingRequest(request, url, controller, csrf, body, send)) return;
      if (await secretRequest(request, url, controller, csrf, body, send)) return;
      const match = /^\/v1\/deployments\/([a-f0-9-]{36})\/(approve|reject|artifact)$/.exec(url.pathname);
      if (match && match[2] === 'artifact' && request.method === 'GET') {
        const result = await artifactManifest(controller, match[1]);
        return send(result.status, result.body);
      }
      if (match && request.method === 'POST' && ['approve', 'reject'].includes(match[2])) {
        try { checkMutation(request, csrf); }
        catch (error) { return send(403, { error: error.message }); }
        const input = await body(request);
        return send(200, adminDeployment(await controller.mutate(match[1], input.digest, match[2], input.secretRevision, input.replaces, { actor: { kind: 'basic', name: credentials.user }, review: input.review })));
      }
      if (request.method === 'GET' && url.pathname === '/') {
        const apps = Object.entries(controller.state.apps).map(([name, app]) => `<p><strong>${html(name)}</strong>: ${html(app.route)} (${html(app.slot)}) ${app.quarantined ? 'Slot quarantined; inspect retained state.' : ''} ${app.archiveRecovery ? `<a href="/v1/apps/${html(name)}/archive-recovery">Review archive recovery</a>` : ''}</p>`).join('');
        const rows = Object.values(controller.state.deployments).reverse().map(d => `<article><h2>${html(d.app)} — ${html(d.status)}</h2><p>Submitted by ${html(d.submitter)} at ${html(d.submittedAt)}</p><code>${html(d.digest)}</code><p>Secret revision: ${html(selectedSecretRevision(controller, d) || 'none')}${d.secretRevision ? ' (pinned for retry)' : ''}</p><p>${html(d.step)} ${d.error ? 'Activation diagnostics are withheld; inspect the recorded application state and original operation.' : ''}</p>${backgroundNotice(d, html)}<details><summary>Resources and migrations</summary><pre>${html(JSON.stringify({ requiredSecrets: d.requiredSecrets || [], secretRevision: selectedSecretRevision(controller, d), resourceChanges: d.resourceChanges, resources: d.resources, migrations: d.migrations }, null, 2))}</pre></details><p><a href="/v1/deployments/${d.id}/artifact">Review full artifact manifest</a></p><p><a href="/admin/review/${d.id}">Review verified comparison and decide</a></p></article>`).join('');
        return send(200, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>fogd approvals</title><style>body{font:16px system-ui;max-width:900px;margin:40px auto;padding:16px;background:#f7f8fa;color:#18212f}article{background:white;border:1px solid #ccd3dc;padding:20px;margin:20px 0;border-radius:8px}code,pre{overflow-wrap:anywhere;white-space:pre-wrap}button{padding:10px 20px;cursor:pointer}h1{font-size:32px}</style><h1>fogd deploy approvals</h1><p><a href="/admin/decisions">Decision history</a></p>${routingPageLink(controller)}<p>Review the exact artifact before approving. Activation may take a few minutes and pauses the app. Only trusted application code is supported.</p>${capacityHTML(controller, html)}${apps}${deliveryHTML(controller, html, csrf)}${dispatchHTML(controller, html, csrf)}${rows || '<p>No submissions yet. Run fogd deploy in a Void app.</p>'}</html>`, 'text/html; charset=utf-8');
      }
      send(404, { error: 'Not found' });
    } catch (error) { send(errorStatus(error), { error: error.message }); }
  });
}


function errorStatus(error) {
  if (error.code === 'APP_ARCHIVE_REVIEW_UNAVAILABLE') return 404;
  if (['APP_ARCHIVE_HELD', 'APP_ARCHIVE_APPROVAL_REFUSED'].includes(error.code)) return 409;
  if (error.code === 'DECISION_REVIEW_STALE') return 409;
  if (error.code === 'ARTIFACT_REVIEW_UNAVAILABLE') return error.status;
  if (['ARTIFACT_PRUNE_PENDING', 'ARTIFACT_PRUNE_REFUSED', 'ARTIFACT_PRUNE_INCOMPLETE'].includes(error.code)) return 503;
  if (['CONTROLLER_STORAGE_UNCERTAIN', 'ROUTE_PUBLICATION_UNCERTAIN', 'ROUTE_STARTUP_UNRECONCILED', 'ROUTE_PREFLIGHT_UNCONFIRMED'].includes(error.code)) return 503;
  if (['QUEUE_OPERATION_UNCONFIRMED', 'CRON_OPERATION_UNCONFIRMED', 'CRON_SNAPSHOT_UNCONFIRMED', 'CRON_RECOVERY_UNCONFIRMED'].includes(error.code)) return 502;
  return 400;
}


function backgroundNotice(request, html) {
  const notice = adminDeployment(request).backgroundWorkNotice;
  return notice ? `<p>${html(notice)}</p>` : '';
}
