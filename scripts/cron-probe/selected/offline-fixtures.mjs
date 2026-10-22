import assert from 'node:assert/strict';
import { join } from 'node:path';
import { backgroundCredentials, privateFaultProject, approveRefresh, approveImports } from './background-fixtures.mjs';
import { negotiatedCapabilities, ordinaryOfflineBuild } from './offline-build.mjs';
import { scopedClient } from './https.mjs';

export async function offlineFixtures(host) {
  const credentials = await backgroundCredentials(host), capabilities = await negotiatedCapabilities(host, credentials.tokens.refresh), builds = {};
  for (const [name, cron] of [['minute', '* * * * *'], ['sparse', '*/3 * * * *']]) {
    const project = await privateFaultProject(host, `offline-${name}-source`, cron);
    builds[name] = await ordinaryOfflineBuild(host, project, join(host.output, `offline-${name}`), capabilities);
    assert.deepEqual(builds[name].verification.native.triggers, { crons: [cron] });
  }
  return { ...credentials, capabilities, builds, approvals: {}, submissions: { refresh: [], imports: [] } };
}
export async function approveOffline(host, fixture, name) {
  assert.ok(['minute', 'sparse'].includes(name)); const build = fixture.builds[name], request = await scopedClient(host, fixture.tokens.refresh);
  const response = await request('/v1/deployments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(build.payload) });
  assert.equal(response.status, 201); const submitted = response.json();
  assert.equal(submitted.app, build.payload.app); assert.equal(submitted.digest, build.verification.release.digest); assert.equal(submitted.status, 'pending');
  const active = await approveRefresh(host, { id: submitted.id, app: submitted.app, digest: submitted.digest, status: submitted.status }, fixture.secret);
  const artifact = await fixture.request(`/v1/deployments/${active.id}/artifact`); assert.equal(artifact.status, 200); assert.deepEqual(artifact.json(), build.payload);
  fixture.approvals.refresh = active; fixture.submissions.refresh.push(active);
  if (!fixture.approvals.imports) {
    fixture.approvals.imports = await approveImports(host, fixture.tokens.imports); fixture.submissions.imports.push(fixture.approvals.imports);
  }
  return active;
}
