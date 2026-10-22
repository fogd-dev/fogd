import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { faultProject } from '../faults/build.mjs';
import { httpsClient, waitFor } from './https.mjs';
import { controllerState, nativeObservation } from './observations.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
export async function backgroundCredentials(host, request) {
  request ||= await httpsClient(host);
  await waitFor('background source admin', async () => (await request('/v1/admin')).status === 200);
  await waitFor('signed background source fleets', async () => {
    for (const fleet of host.policy.fleets) await nativeObservation(host, fleet.id);
    return true;
  });
  const tokens = {};
  for (const app of ['refresh', 'imports']) tokens[app] = (await host.json(['admin', 'issue-token', `background-${app}-builder`, app])).token;
  return { tokens, secret: randomBytes(32).toString('hex'), request };
}
export async function privateFaultProject(host, name, cron = '* * * * *') {
  const { project } = await faultProject(join(host.output, name), cron);
  await symlink(join(repo, 'examples/refresh/node_modules'), join(project, 'node_modules'), 'dir');
  return project;
}
export async function approveRefresh(host, submitted, secret) {
  assert.equal(submitted.app, 'refresh'); assert.equal(submitted.status, 'pending');
  const revision = (await host.json(['admin', 'secrets', 'refresh'], { inputText: JSON.stringify({ REFRESH_TOKEN: secret }) })).revision;
  await host.command(['admin', 'approve', submitted.id, submitted.digest, revision]);
  const paused = await host.json(['admin', 'dispatch', 'refresh', 'pause']); assert.equal(paused.observed, 'paused');
  const initialPauseAt = Date.parse(paused.observedAt); assert.ok(Number.isSafeInteger(initialPauseAt));
  return { ...await approved(host, submitted), initialPauseAt };
}
export async function approveImports(host, token) {
  const submitted = await host.json(['deploy', '--name', 'imports'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token }, cwd: join(repo, 'examples/imports') });
  assert.equal(submitted.status, 'pending'); await host.command(['admin', 'approve', submitted.id, submitted.digest]);
  return approved(host, submitted);
}
export async function backgroundFixtures(host, request) {
  const credentials = await backgroundCredentials(host, request), project = await privateFaultProject(host, 'refresh-source');
  const submitted = await host.json(['deploy', '--name', 'refresh'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: credentials.tokens.refresh }, cwd: project });
  const refresh = await approveRefresh(host, submitted, credentials.secret), imports = await approveImports(host, credentials.tokens.imports);
  return { ...credentials, project, approvals: { refresh, imports } };
}
async function approved(host, submitted) {
  const state = await controllerState(host), app = state.apps[submitted.app], active = state.deployments[app.active];
  assert.equal(active.id, submitted.id); assert.equal(active.status, 'active'); assert.equal(active.digest, submitted.digest);
  return { ...submitted, slot: app.slot, secretRevision: active.secretRevision, version: active.version };
}

export async function importJob(request, id, text) {
  const response = await request('/api/imports', { app: 'imports', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text }) });
  assert.equal(response.status, 202); return response.json();
}
