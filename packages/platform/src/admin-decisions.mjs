import { decisionHistory } from './decision-history.mjs';
import { html } from './admin-html.mjs';
import { appName } from '@fogd/runtime/artifact';

export async function decisionHistoryRequest(request, url, controller, send) {
  if (request.method !== 'GET' || !['/v1/admin/decisions', '/admin/decisions'].includes(url.pathname)) return false;
  if ([...url.searchParams.keys()].some(key => !['app', 'before'].includes(key)) || ['app', 'before'].some(key => url.searchParams.getAll(key).length > 1)) throw new Error('Invalid decision history selection');
  const app = url.searchParams.get('app') ?? undefined, before = url.searchParams.get('before') ?? undefined;
  if (app !== undefined) appName(app);
  const result = await controller.exclusive(() => decisionHistory(controller, { app, before }));
  if (url.pathname.startsWith('/v1/')) send(200, result);
  else send(200, page(result, app), 'text/html; charset=utf-8');
  return true;
}

function page(result, app) {
  const rows = result.entries.map(entry => `<tr><td>${html(entry.at)}</td><td>${html(entry.actor.name)}<br>Basic credential</td><td>${html(entry.app)}<br><code>${html(entry.deployment)}</code><br><code>${html(entry.digest)}</code></td><td>${html(entry.action)}<br>Requested secret revision: <code>${html(entry.secretRevision || 'none')}</code></td><td>${html(entry.outcome)}<br>Recorded application status: ${html(entry.applicationStatus)}</td></tr>`).join('');
  const query = new URLSearchParams({ ...(app ? { app } : {}), ...(result.next ? { before: result.next } : {}) });
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>fogd decision history</title><style>body{font:16px system-ui;margin:2rem;max-width:1200px}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;border:1px solid #bbc;padding:.7rem}code{overflow-wrap:anywhere}</style><h1>Decision history${app ? `: ${html(app)}` : ''}</h1><p><a href="/">Deployment approvals</a></p><p>${html(result.principalNotice)}</p><p>${html(result.outcomeNotice)}</p><table><thead><tr><th>Time</th><th>Authenticated credential</th><th>Application / artifact</th><th>Decision</th><th>Outcome</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No recorded decisions in this selection.</td></tr>'}</tbody></table>${result.next ? `<p><a href="?${html(query.toString())}">Older decisions</a></p>` : ''}</html>`;
}
