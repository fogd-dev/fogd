import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { platformClient } from './platform-client.mjs';
import { accountsBrowser } from './accounts-browser.mjs';
import { compose, stackRoot, run } from '../packages/cli/src/local.mjs';
import { expect } from './guestbook-browser.mjs';

const client = await platformClient();
const app = 'accounts';
assert.equal(Object.keys((await client.api('/v1/admin')).apps).length, 0, 'Use a fresh disposable stack');
const project = join(stackRoot, 'examples/accounts');
const secret = randomBytes(32).toString('hex'), rotated = randomBytes(32).toString('hex');
async function setSecret(value, owner = app) {
  const result = spawnSync(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), 'admin', 'secrets', owner], {
    env: client.env, input: JSON.stringify({ BETTER_AUTH_SECRET: value }), encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, 'Secret CLI failed');
  assert.ok(!result.stdout.includes(value)); assert.ok(!result.stderr.includes(value));
  return JSON.parse(result.stdout);
}
async function approve(release, revision) {
  const { csrf } = await client.api('/v1/admin');
  return client.api(`/v1/deployments/${release.id}/approve`, { method: 'POST', headers: { 'X-Fogd-CSRF': csrf }, body: JSON.stringify({ digest: release.digest, secretRevision: revision }) });
}
async function noDisclosure(release) {
  const state = await client.api('/v1/admin');
  assert.equal(state.deployments[release.id].version, undefined);
  const artifact = await client.api(`/v1/deployments/${release.id}/artifact`);
  for (const value of [secret, rotated]) {
    assert.ok(!JSON.stringify(state).includes(value));
    for (const file of artifact.files) assert.ok(!Buffer.from(file.data, 'base64').toString().includes(value));
  }
}
const invalid = await client.submit(project, app);
assert.deepEqual(invalid.requiredSecrets, ['BETTER_AUTH_SECRET']);
await assert.rejects(approve(invalid), /secret revision/);
assert.equal((await client.appRequest(app, '/')).status, 404);
const bad = await setSecret('too-short');
const failed = await approve(invalid, bad.revision);
assert.equal(failed.status, 'failed'); assert.equal(failed.step, 'validating-application');
assert.equal((await client.appRequest(app, '/')).status, 503);
const revision = await setSecret(secret);
await assert.rejects(approve(invalid, revision.revision), /pinned/);
await client.decide(invalid, 'reject');
const first = await client.submit(project, app);
const cliApproval = JSON.parse(await run(process.execPath, [join(stackRoot, 'packages/cli/bin/fogd.js'), 'admin', 'approve', first.id, first.digest, revision.revision], { env: client.env, capture: true }));
assert.equal(cliApproval.status, 'active');
await noDisclosure(first);
assert.equal((await client.appRequest(app, '/api/private')).status, 401);
for (const path of ['/__void/ready', '/__void/migrate/auth']) assert.equal((await client.appRequest(app, path, { method: path.endsWith('auth') ? 'POST' : 'GET', headers: { 'x-void-internal': 'guess' } })).status, 404);
const email = `member-${Date.now()}@example.test`;
const account = await accountsBrowser(client.browserURL(app), email, 'A local password for tests');
try {
  await account.enroll();
  const privateURL = new URL('/api/private', client.browserURL(app)).href;
  assert.equal((await account.context.request.get(privateURL)).status(), 200);
  const peer = await client.submit(project, 'accounts-peer');
  const peerSecret = await setSecret(randomBytes(32).toString('hex'), 'accounts-peer');
  assert.equal((await approve(peer, peerSecret.revision)).status, 'active');
  const cookie = (await account.context.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
  assert.equal((await client.appRequest('accounts-peer', '/api/private', { headers: { Cookie: cookie } })).status, 401);
  const adminURL = client.env.FOGD_SERVER || `http://127.0.0.1:${client.env.FOGD_ADMIN_PORT || 8788}`;
  assert.equal((await fetch(adminURL + '/v1/admin', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(adminURL + '/v1/deployments', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const unchanged = await client.submit(project, app);
  assert.equal((await approve(unchanged, revision.revision)).status, 'active');
  await account.ready('Session active');
  const next = await setSecret(rotated);
  await account.ready('Session active');
  const update = await client.submit(project, app);
  await assert.rejects(approve(update, revision.revision), /secret revision/);
  assert.equal((await approve(update, next.revision)).status, 'active');
  await noDisclosure(update);
  await account.ready('Anonymous');
  await account.signIn(); await account.signedIn();
  await compose(['restart', 'controller', 'workerd', 'slot-1-a', 'slot-1-b'], client.env);
  await expect.poll(async () => {
    try { return (await client.appRequest(app, '/')).status; } catch { return 0; }
  }, { timeout: 90000 }).toBe(200);
  await account.ready('Session active');
  assert.deepEqual(await (await account.context.request.get(privateURL)).json(), { email });
  await account.signOut(); assert.equal((await account.context.request.get(privateURL)).status(), 401);
  await noDisclosure(update);
} finally { await account.browser.close(); }
console.log('PASS: missing/invalid secrets, pinned approval and rotation, private artifacts/status, native account signup/login/logout, app/control-plane separation, sessions and accounts across replica/controller/gateway restart');
