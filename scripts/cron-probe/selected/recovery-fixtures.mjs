import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { faultProject } from '../faults/build.mjs';
import { httpsClient, waitFor } from './https.mjs';
import { controllerState, nativeObservation, setFaultPolicy } from './observations.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
export async function recoveryFixtures(host, request) {
  request ||= await httpsClient(host);
  await waitFor('recovery source admin', async () => (await request('/v1/admin')).status === 200);
  await waitFor('signed recovery source fleets', async () => {
    for (const fleet of host.policy.fleets) await nativeObservation(host, fleet.id);
    return true;
  });
  const tokens = {};
  for (const app of ['refresh', 'imports']) tokens[app] = (await host.json(['admin', 'issue-token', `recovery-${app}-builder`, app])).token;
  const { project } = await faultProject(join(host.output, 'refresh-source'));
  await symlink(join(repo, 'examples/refresh/node_modules'), join(project, 'node_modules'), 'dir');
  const refresh = await host.json(['deploy', '--name', 'refresh'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: tokens.refresh }, cwd: project });
  assert.equal(refresh.status, 'pending');
  const secret = randomBytes(32).toString('hex');
  const revision = (await host.json(['admin', 'secrets', 'refresh'], { inputText: JSON.stringify({ REFRESH_TOKEN: secret }) })).revision;
  await host.command(['admin', 'approve', refresh.id, refresh.digest, revision]);
  const paused = await host.json(['admin', 'dispatch', 'refresh', 'pause']); assert.equal(paused.observed, 'paused');
  const imports = await host.json(['deploy', '--name', 'imports'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: tokens.imports }, cwd: join(repo, 'examples/imports') });
  assert.equal(imports.status, 'pending'); await host.command(['admin', 'approve', imports.id, imports.digest]);
  const state = await controllerState(host), approvals = {};
  for (const [name, submitted] of Object.entries({ refresh, imports })) {
    const app = state.apps[name], active = state.deployments[app.active];
    assert.equal(active.id, submitted.id); assert.equal(active.status, 'active'); assert.equal(active.digest, submitted.digest);
    approvals[name] = { ...submitted, slot: app.slot, secretRevision: active.secretRevision };
  }
  await setFaultPolicy(host, approvals.refresh.slot, refresh.id, 'healthy', 'snapshot-a');
  return { approvals, tokens, secret, request };
}

export async function importJob(request, id, text) {
  const response = await request('/api/imports', { app: 'imports', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, text }) });
  assert.equal(response.status, 202); return response.json();
}

export async function recoveredData(host, approvals) {
  const values = {};
  for (const name of ['refresh', 'imports']) {
    const active = approvals[name];
    values[name] = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
  }
  return values;
}

export function applicationData(observed) {
  return Object.fromEntries(Object.entries(observed).map(([name, value]) => [name,
    value.databases.map(database => ({ database: database.database, migrations: database.migrations, data: database.data }))]));
}
