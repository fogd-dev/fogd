import assert from 'node:assert/strict';
import { join } from 'node:path';
import { configEnv, stackRoot, run } from '../packages/cli/src/local.mjs';
import { request } from './http.mjs';

export async function platformClient(env = null) {
  env ||= await configEnv();
  const scheme = env.FOGD_TLS === '1' ? 'https' : 'http';
  const origin = env.FOGD_SERVER || `${scheme}://127.0.0.1:${env.FOGD_ADMIN_PORT || 8788}`;
  const publicOrigin = env.FOGD_URL || `${scheme}://127.0.0.1:${env.FOGD_HTTP_PORT || 8787}`;
  const basic = `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER || 'admin'}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`;
  async function api(path, options = {}) {
    const response = await fetch(origin + path, { ...options, headers: { Authorization: basic, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(900000) });
    const body = await response.json();
    assert.ok(response.ok, JSON.stringify(body));
    return body;
  }
  async function submit(dir, app) {
    const previous = new Set(Object.keys((await api('/v1/admin')).deployments));
    await run(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), 'deploy', '--name', app], { cwd: dir, env });
    const created = Object.values((await api('/v1/admin')).deployments).filter(d => d.app === app && !previous.has(d.id));
    assert.equal(created.length, 1); return created[0];
  }
  async function decide(release, action = 'approve') {
    const { csrf } = await api('/v1/admin');
    return api(`/v1/deployments/${release.id}/${action}`, { method: 'POST', headers: { 'X-Fogd-CSRF': csrf }, body: JSON.stringify({ digest: release.digest }) });
  }
  const host = app => `${app}.${env.FOGD_BASE_DOMAIN || 'localhost'}`;
  const appRequest = (app, path, options = {}) => request(publicOrigin + path, { ...options, headers: { ...options.headers, Host: host(app) }, signal: AbortSignal.timeout(30000) });
  const browserURL = app => { const url = new URL(publicOrigin); url.hostname = host(app); return url.href; };
  return { env, api, submit, decide, appRequest, browserURL };
}
