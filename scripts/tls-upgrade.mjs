// Qualification drill for the default two-slot M8a fixture; not a general migration tool.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseEnv } from 'node:util';
import { createHash, X509Certificate } from 'node:crypto';
import { composeResolved } from '../packages/cli/src/recovery/bundle.mjs';
import { run, compose, stackRoot } from '../packages/cli/src/local.mjs';
import { platformClient } from './platform-client.mjs';
import { accountsBrowser } from './accounts-browser.mjs';
import { expect } from './guestbook-browser.mjs';

const bundle = resolve(process.argv[2]);
const project = process.argv[3];
assert.match(project, /^fogd-m8b2-upgrade[a-z0-9-]*$/);
const certDir = resolve(process.argv[4]);
const output = join(stackRoot, '.fogd', project);
const envFile = output + '.env';
const cli = join(stackRoot, 'packages/cli/bin/fogd.js');
const source = composeResolved(JSON.parse(await readFile(join(bundle, 'compose.json'), 'utf8')));
assert.equal(source.volumes.tls, undefined, 'Use a pre-TLS six-volume snapshot');
const control = source.services.controller.environment;
const settings = { COMPOSE_PROJECT_NAME: project, FOGD_PROFILE: 'local', FOGD_TLS: '0' };
for (const key of ['FOGD_ADMIN_USER', 'FOGD_ADMIN_PASSWORD', 'FOGD_DEPLOY_TOKEN', 'FOGD_GATEWAY_TOKEN', 'FOGD_BASE_DOMAIN', 'FOGD_BUCKET']) settings[key] = control[key];
for (const [key, from] of Object.entries({ FOGD_BUCKET_ENDPOINT: 'S3_ENDPOINT', FOGD_BUCKET_REGION: 'AWS_REGION', FOGD_BUCKET_USER: 'AWS_ACCESS_KEY_ID', FOGD_BUCKET_PASSWORD: 'AWS_SECRET_ACCESS_KEY' })) settings[key] = control[from];
for (const [index, slot] of JSON.parse(control.FOGD_SLOTS).entries()) {
  settings[`FOGD_SLOT_${index + 1}_PREFIX`] = slot.prefix;
  for (const [replica, node] of slot.nodes.entries()) {
    const letter = replica ? 'B' : 'A';
    const service = `slot-${index + 1}-${letter.toLowerCase()}`;
    assert.equal(node, service, 'This drill uses default service hostnames');
    settings[`FOGD_SLOT_${index + 1}_${letter}_ID`] = source.services[service].environment.CELLD_NODE;
  }
}
for (const [service, key] of [['controller', 'FOGD_ADMIN_PORT'], ['workerd', 'FOGD_HTTP_PORT']]) {
  const port = source.services[service].ports[0];
  assert.equal(port.host_ip, '127.0.0.1'); settings[key] = String(port.published);
}
// Single-quoted dotenv values preserve literal dollar signs from the M8a drill.
assert.ok(Object.values(settings).every(v => typeof v === 'string' && !/[\n\r']/.test(v)));
await writeFile(envFile, Object.entries(settings).map(([k, v]) => `${k}='${v}'`).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
const env = { ...process.env, ...settings, FOGD_ENV_FILE: envFile };
delete env.FOGD_COMPOSE_FILE;
await run(process.execPath, [cli, 'restore', bundle, '--project', project, '--output', output], { env });
const oldEnv = { ...env, FOGD_COMPOSE_FILE: join(output, 'compose.json') };
await compose(['up', '-d', '--pull', 'never'], oldEnv);
const beforeClient = await platformClient(env);
await expect.poll(async () => { try { return (await beforeClient.appRequest('notebook', '/api/entries')).status; } catch { return 0; } }, { timeout: 120000 }).toBe(200);
const before = await beforeClient.api('/v1/admin');
const entries = await (await beforeClient.appRequest('notebook', '/api/entries')).json();
const email = `upgrade-${Date.now()}@example.test`, password = 'Upgrade drill password';
const oldAccount = await accountsBrowser(beforeClient.browserURL('accounts'), email, password);
try { await oldAccount.enroll(); } finally { await oldAccount.browser.close(); }
await compose(['stop'], oldEnv);
await run(process.execPath, [cli, 'tls', 'import', join(certDir, 'server.pem'), join(certDir, 'server.key')], { env });
// Do not override the shared settings that up persists with stale local flags.
const cliEnv = { ...process.env, FOGD_ENV_FILE: envFile };
delete cliEnv.FOGD_COMPOSE_FILE;
await run(process.execPath, [cli, 'up', '--shared'], { env: cliEnv });
const afterEnv = { ...cliEnv, ...parseEnv(await readFile(envFile, 'utf8')) };
const afterClient = await platformClient(afterEnv);
await expect.poll(async () => { try { return (await afterClient.appRequest('notebook', '/api/entries')).status; } catch { return 0; } }, { timeout: 120000 }).toBe(200);
const after = await afterClient.api('/v1/admin');
assert.deepEqual(after.deployments, before.deployments);
assert.deepEqual(after.secrets, before.secrets);
for (const app of ['accounts', 'notebook']) assert.equal(after.apps[app].quarantined, undefined);
assert.deepEqual(await (await afterClient.appRequest('notebook', '/api/entries')).json(), entries);
const cert = new X509Certificate(await readFile(join(certDir, 'server.pem')));
const pin = createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
const account = await accountsBrowser(afterClient.browserURL('accounts'), email, password, { args: [`--ignore-certificate-errors-spki-list=${pin}`] });
try { await account.signIn(); await account.signedIn(); assert.ok((await account.context.cookies()).some(c => c.secure && c.httpOnly)); }
finally { await account.browser.close(); }
const pending = Object.values(after.deployments).find(d => d.app === 'accounts' && d.status === 'pending');
assert.ok(pending, 'M8a fixture must retain a pending accounts release');
const { csrf } = await afterClient.api('/v1/admin');
const approved = await afterClient.api(`/v1/deployments/${pending.id}/approve`, { method: 'POST', headers: { 'X-Fogd-CSRF': csrf }, body: JSON.stringify({ digest: pending.digest, secretRevision: after.secrets.accounts.revision }) });
assert.equal(approved.status, 'active');
console.log('PASS: six-volume M8a restore, old HTTP login, deliberate shared HTTPS upgrade, D1/R2/DO preservation, account login, secret and approval history preservation, pre-upgrade pending release approval');
