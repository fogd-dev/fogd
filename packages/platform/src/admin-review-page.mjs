import { html } from './admin-html.mjs';
import { approvalButtons } from './admin-approval-controls.mjs';

const title = report => `Review ${report.app}`;
const style = 'body{font:16px system-ui;max-width:1200px;margin:2rem auto;padding:1rem;background:#f7f8fa;color:#18212f}section,article{background:white;border:1px solid #ccd3dc;padding:1rem;margin:1rem 0;border-radius:8px}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;border:1px solid #ccd3dc;padding:.6rem;overflow-wrap:anywhere}th:first-child,td:first-child{min-width:5rem}li{overflow-wrap:anywhere}code,pre{white-space:pre-wrap;overflow-wrap:anywhere}pre{max-height:65vh;overflow:auto}button{padding:.7rem 1.2rem;margin-right:.5rem;cursor:pointer}.panels{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}dt{font-weight:bold}dd{margin:0 0 .6rem}@media(max-width:700px){.panels{grid-template-columns:1fr}}';
function shell(heading, content) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${html(heading)} · fogd</title><style>${style}</style><h1>${html(heading)}</h1><nav><a href="/">Deployment approvals</a> · <a href="/admin/decisions">Decision history</a></nav>${content}</html>`;
}
const identity = value => value ? `<code>${html(value.id)}</code><br><code>${html(value.digest)}</code>` : 'No active release';
const fileLink = (report, path) => `<a href="/admin/review/${report.proposed.id}/file?${html(new URLSearchParams({ path, review: report.review }).toString())}">${html(path)}</a>`;
const json = value => `<pre>${html(JSON.stringify(value, null, 2))}</pre>`;

export function artifactReviewPage(controller, snapshot, csrf) {
  const report = snapshot.report, request = controller.state.deployments[report.proposed.id];
  const rows = report.comparison.files.map(file => {
    return `<tr><td>${html(file.change)}</td><td>${fileLink(report, file.path)}</td><td>${file.before ? `${file.before.bytes} bytes<br><code>${html(file.before.sha256)}</code>` : 'Absent'}</td><td>${file.after ? `${file.after.bytes} bytes<br><code>${html(file.after.sha256)}</code>` : 'Absent'}</td></tr>`;
  }).join('');
  const paths = [...new Set([...(snapshot.baseline?.files || []), ...snapshot.proposed.files].map(file => file.path))].sort();
  const inventory = `<details><summary>All verified files, including unchanged (${paths.length})</summary><ul>${paths.map(path => `<li>${fileLink(report, path)}</li>`).join('')}</ul></details>`;
  const content = `<section><h2>Exact submission</h2><dl><dt>Proposed artifact</dt><dd>${identity(report.proposed)}</dd><dt>Active baseline</dt><dd>${identity(report.active)}</dd><dt>Recorded deployment status</dt><dd>${html(report.proposed.status)}</dd><dt>Selected secret revision</dt><dd><code>${html(report.proposed.secretRevision || 'none')}</code></dd></dl><p>Displayed artifact bytes passed canonical validation and digest verification. This review runs no application code or SQL.</p><p>Artifact files can contain author-supplied sensitive content. Keep this authenticated review private.</p></section>
<section><h2>Recorded application state</h2><p>Runtime readiness and application business outcomes are not assessed by artifact review. A successful decision is not a live health check. Failed or uncertain operations require inspection before retry.</p>${json(report.state)}</section>
<section><h2>Code, assets and SQL differences</h2><p>${report.comparison.files.length} changed files; ${report.comparison.unchangedFiles} unchanged files. Select a file to inspect verified before/after text.</p><table><thead><tr><th>Change</th><th>File</th><th>Before</th><th>Proposed</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No file differences.</td></tr>'}</tbody></table>${inventory}</section>
<section><h2>Resource and migration declarations</h2><p>Migration-file differences compare artifacts, not live SQL or an execution plan. Failed activations can retain resources and migrations beyond the active artifact. Required secret names are declarations; private secret values are withheld.</p>${json(report.comparison.declarations)}<h3>Changed declarations</h3>${json(report.comparison.changedDeclarations)}</section>
<section><h2>Separate decision</h2><p>Decide only on the submission and secret revision shown above. Any change to this app's review context requires reloading this exact submission.</p><div id="decisions">${approvalButtons(controller, request, report.review) || '<p>This recorded deployment is not pending or retryable.</p>'}</div><p id="decision-result" role="status" aria-live="polite"></p></section>${decisionScript(csrf)}`;
  return shell(title(report), content);
}
function decisionScript(csrf) {
  return `<script>for(const b of document.querySelectorAll('#decisions button[data-id]'))b.onclick=async()=>{const buttons=[...document.querySelectorAll('#decisions button')];buttons.forEach(x=>x.disabled=true);const status=document.getElementById('decision-result');status.textContent='Decision submitted. Waiting for the controller outcome.';try{const r=await fetch('/v1/deployments/'+b.dataset.id+'/'+b.dataset.action,{method:'POST',headers:{'Content-Type':'application/json','X-Fogd-CSRF':${JSON.stringify(csrf)}},body:JSON.stringify({digest:b.dataset.digest,review:b.dataset.review,secretRevision:b.dataset.secretRevision||null,...(b.dataset.replaces?{replaces:{deployment:b.dataset.replaces,digest:b.dataset.replacesDigest}}:{})})});await r.body?.cancel();if(!r.ok){status.textContent=r.status===409?'Review context changed or artifact verification failed. Reload this exact submission before deciding.':'Decision was refused or its outcome is unconfirmed. Inspect the current application and decision history before retrying.';return;}location.reload();}catch{status.textContent='The decision response is unconfirmed. Inspect application state and decision history before retrying.';}}</script>`;
}
export function artifactFilePage(snapshot, file) {
  const report = snapshot.report;
  const panel = (name, value) => `<article><h2>${name}</h2>${value ? `<p>${value.bytes} bytes · Whole-file SHA-256: <code>${html(value.sha256)}</code></p><pre>${html(value.text)}</pre>` : '<p>File absent from this artifact.</p>'}</article>`;
  const query = new URLSearchParams({ path: file.path, review: report.review, ...(file.next === null ? {} : { offset: String(file.next) }) });
  return shell(file.path, `<p><a href="/admin/review/${report.proposed.id}">Back to this submission</a></p><p>Submission ${identity(report.proposed)}. Large text previews are paged and can overlap at character boundaries. Offset: ${file.offset}. Binary contents are not rendered.</p><div class="panels">${panel('Active baseline', file.before)}${panel('Proposed artifact', file.after)}</div>${file.next === null ? '' : `<p><a href="?${html(query.toString())}">Next text page</a></p>`}<p><a href="/v1/deployments/${report.proposed.id}/artifact">Authenticated proposed artifact manifest</a></p>`);
}
export function artifactReviewFailure(message) {
  return shell('Review unavailable', `<section><p>${html(message)}</p><p>No decision was made by this review request. Retain original controller data and inspect the selected submission.</p></section>`);
}
