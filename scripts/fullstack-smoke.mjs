// Run against a disposable stack with no active guestbook app. Approval is explicit.
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { configEnv, stackRoot, run, compose } from '../packages/cli/src/local.mjs';
import { request } from './http.mjs';
import { expect, verifyBrowser } from './guestbook-browser.mjs';

const env = await configEnv();
const app = env.FOGD_APP_NAME || 'guestbook';
const publicOrigin = env.FOGD_URL || `http://127.0.0.1:${env.FOGD_HTTP_PORT || 8787}`;
const host = `${app}.${env.FOGD_BASE_DOMAIN || 'localhost'}`;
const browserURL = new URL(publicOrigin); browserURL.hostname = host;
const adminOrigin = env.FOGD_SERVER || `http://127.0.0.1:${env.FOGD_ADMIN_PORT || 8788}`;
const basic = `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER || 'admin'}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`;
const bearer = `Bearer ${env.FOGD_DEPLOY_TOKEN}`;
const cli = join(stackRoot, 'packages/cli/bin/fogd.js');
const project = join(stackRoot, 'examples/guestbook');

async function api(path, { auth = basic, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(adminOrigin + path, { method,
    headers: { Authorization: auth, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(900000) });
  assert.equal(response.status, 200);
  return response.json();
}
const appRequest = path => request(publicOrigin + path, { headers: { Host: host }, signal: AbortSignal.timeout(30000) });
async function submit(dir) {
  const before = new Set(Object.keys((await api('/v1/admin')).deployments));
  await run(process.execPath, [cli, 'deploy', '--name', app], { cwd: dir, env });
  const created = Object.values((await api('/v1/admin')).deployments).filter(d => d.app === app && !before.has(d.id));
  assert.equal(created.length, 1);
  const release = created[0];
  assert.equal((await api(`/v1/deployments/${release.id}`, { auth: bearer })).status, 'pending');
  return release;
}
async function decide(release, action) {
  const { csrf } = await api('/v1/admin');
  return api(`/v1/deployments/${release.id}/${action}`, { method: 'POST',
    body: { digest: release.digest }, headers: { 'X-Fogd-CSRF': csrf } });
}
async function secondRelease() {
  const parent = join(stackRoot, '.fogd/fullstack'); await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, 'v2-'));
  await cp(project, dir, { recursive: true, filter: path => !['node_modules', 'dist', '.void', '.wrangler', '.void-wrangler.jsonc'].includes(basename(path)) });
  await symlink(join(project, 'node_modules'), join(dir, 'node_modules'));
  const schema = join(dir, 'db/schema.ts');
  const source = await readFile(schema, 'utf8'); assert.ok(source.includes('export const messages'));
  await writeFile(schema, source.replace('  text:', '  label: text("label").notNull().default("visitor"),\n  text:'));
  await run('pnpm', ['exec', 'void', 'db', 'generate'], { cwd: dir, env });
  const page = join(dir, 'pages/index.tsx');
  await writeFile(page, (await readFile(page, 'utf8')).replace('<h1>Guestbook</h1>', '<h1>Guestbook, growing</h1><a href="/history">History</a>'));
  await writeFile(join(dir, 'pages/history.server.ts'), "export { loader } from './index.server';\n");
  await writeFile(join(dir, 'pages/history.tsx'), "import type { Props } from './index.server';\nexport default function History({ messages }: Props) { return <main><h1>History</h1><ul>{messages.map(m => <li key={m.id}>{m.label}: {m.text}</li>)}</ul></main>; }\n");
  await run('pnpm', ['run', 'typecheck'], { cwd: dir, env });
  return dir;
}

const original = await api('/v1/admin');
assert.ok(!original.apps[app], 'Use a fresh disposable stack or an unused FOGD_APP_NAME; this test does not reset existing data');
const rejected = await submit(project);
assert.equal((await appRequest('/')).status, 404);
assert.equal((await decide(rejected, 'reject')).status, 'rejected');
assert.equal((await appRequest('/')).status, 404);
const first = await submit(project);
const firstApproval = await decide(first, 'approve');
assert.equal(firstApproval.status, 'active', firstApproval.error);
for (const path of ['/.assetsignore', '/wrangler.json', '/.dev.vars', '/.env']) {
  assert.equal((await appRequest(path)).status, 404, `Excluded asset was served: ${path}`);
}
const firstMessage = `First release ${Date.now()}`;
await verifyBrowser(browserURL.href, firstMessage);
const v2 = await secondRelease();
const second = await submit(v2);
assert.match(await (await appRequest('/')).text(), /<h1>Guestbook<\/h1>/);
const secondApproval = await decide(second, 'approve');
assert.equal(secondApproval.status, 'active', secondApproval.error);
const rows = await (await appRequest('/api/messages')).json();
assert.ok(rows.some(row => row.text === firstMessage && row.label === 'visitor'));
const history = (await (await appRequest('/history')).text()).replaceAll(/<!--[\s\S]*?-->/g, '');
assert.match(history, /<h1>History<\/h1>/);
assert.ok(history.includes(`visitor: ${firstMessage}`));
await verifyBrowser(browserURL.href, `Second release ${Date.now()}`, 'Guestbook, growing');
const status = JSON.parse(await run(process.execPath, [cli, 'status', second.id], { env, capture: true }));
assert.equal(status.status, 'active'); assert.equal(status.step, 'complete'); assert.equal(status.error, null);
assert.equal(status.digest, second.digest);
await compose(['restart', 'controller', 'workerd'], env);
await expect.poll(async () => {
  try { return (await appRequest('/api/messages')).status; } catch { return 0; }
}, { timeout: 30000 }).toBe(200);
assert.ok((await (await appRequest('/api/messages')).json()).some(row => row.text === firstMessage));
console.log('PASS: native Void pages, CSS/client assets, form and typed API, rejection/approval, two releases, additive SQL, status, controller/gateway restart');
