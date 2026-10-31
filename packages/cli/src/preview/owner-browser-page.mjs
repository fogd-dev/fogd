export const previewOwnerPage = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview owner controls</title><link rel="stylesheet" href="/owner.css"><script src="/owner.js" defer></script><main><h1>Preview owner controls</h1><p>Inspect or stop this preview. Production approval and data deletion are separate actions.</p><label for="owner-key">Owner access key</label><input id="owner-key" type="password" autocomplete="off" minlength="64" maxlength="64"><button id="unlock" type="button">Inspect preview</button><p id="notice" role="status" aria-live="polite">Use the key from the private access file. It is different from the viewer key.</p><section id="details" hidden><h2>Selected preview</h2><dl><dt>Application</dt><dd id="app"></dd><dt>Preview</dt><dd id="preview"></dd><dt>Submission</dt><dd id="submission"></dd><dt>Release</dt><dd id="digest"></dd><dt>Expires</dt><dd id="expiresAt"></dd><dt>State</dt><dd id="state"></dd></dl><p id="retention"></p><p><a id="application" target="_blank" rel="noopener noreferrer">Open application</a></p><p>These buttons stop only this preview. The source submission stays unchanged.</p><div class="actions"><button id="refresh" type="button">Refresh status</button><button id="decline" type="button" disabled>Decline preview</button><button id="revoke" type="button" disabled>Revoke preview</button></div></section><noscript><p>These controls require JavaScript. Use fogd preview status or fogd preview stop from the CLI.</p></noscript></main></html>`;

export const previewOwnerStyle = `body{font:16px system-ui;margin:0;padding:24px;background:#f8fafc;color:#172033}main{max-width:48rem;margin:auto}label,dt{display:block;font-weight:600;margin-top:16px}input,button{font:inherit;padding:10px;box-sizing:border-box}input{display:block;width:28rem;max-width:100%;margin:8px 0}button{cursor:pointer;margin:4px 8px 4px 0}button:disabled{cursor:default}dd{margin:4px 0;overflow-wrap:anywhere}.actions{display:flex;flex-wrap:wrap}a{color:#164da8}#notice{padding:12px;border:1px solid #94a3b8;border-radius:4px}button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid #2563eb;outline-offset:3px}`;

export const previewOwnerScript = String.raw`(() => {
  const element = id => document.getElementById(id);
  let ownerKey, busy = false, canStop = false;
  const buttons = () => {
    element('unlock').disabled = busy;
    element('refresh').disabled = busy;
    for (const id of ['decline', 'revoke']) element(id).disabled = busy || !canStop;
  };
  const render = value => {
    element('details').hidden = false;
    for (const id of ['app', 'preview', 'submission', 'digest', 'expiresAt', 'state']) element(id).textContent = value[id] ?? 'Not observed';
    canStop = value.runtimeObserved === true && !value.stopRequested && value.state === 'running';
    element('application').href = value.origin || '#';
    element('application').hidden = !value.origin || value.state !== 'running' || value.runtimeObserved !== true;
    element('retention').textContent = value.state === 'stopped'
      ? 'Execution is stopped. Data, resources and storage charges remain retained. Memory retirement requires the CLI and its original expiry checks.'
      : 'Stopping retains data and resources. Process state does not establish application health.';
    element('notice').textContent = value.runtimeObserved !== true ? 'A host operation is pending. No runtime state was observed.'
      : value.shutdownOrdered === false ? 'Stopped without confirmed storage ordering. Retain all evidence and inspect with the CLI.'
      : value.state === 'stopped' ? 'Preview stopped. Production activation is unchanged.' : 'Status verified for this exact preview.';
  };
  const request = async (action, reason) => {
    if (busy || !ownerKey) return;
    busy = true;
    if (action === 'stop') canStop = false;
    buttons(); element('notice').textContent = action === 'stop' ? 'Stopping preview; keep this page open.' : 'Inspecting preview…';
    try {
      const response = await fetch('/' + action, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ownerKey }, body: JSON.stringify(reason ? { reason } : {}) });
      if (!response.ok) throw new Error('Owner action unavailable. Refresh status or inspect retained evidence with the CLI; no action was automatically retried.');
      render(await response.json());
    } catch (error) {
      canStop = false;
      element('notice').textContent = error.message.startsWith('Owner action') ? error.message : 'Connection lost; the result is unknown. Refresh status or use the CLI before another action. No action was automatically retried.';
    } finally { busy = false; buttons(); }
  };
  const unlock = () => {
    if (busy) return;
    ownerKey = element('owner-key').value; element('owner-key').value = '';
    if (!/^[a-f0-9]{64}$/.test(ownerKey)) { ownerKey = undefined; element('notice').textContent = 'Enter the owner access key from the private file.'; return; }
    void request('status');
  };
  element('unlock').onclick = unlock;
  element('owner-key').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); unlock(); } };
  element('refresh').onclick = () => { void request('status'); };
  element('decline').onclick = () => { void request('stop', 'declined'); };
  element('revoke').onclick = () => { void request('stop', 'revoked'); };
})();`;
