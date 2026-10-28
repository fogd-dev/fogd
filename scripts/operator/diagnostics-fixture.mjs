import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFixture } from '../capacity/write-fixture.mjs';
import { httpsClient, waitFor } from '../cron-probe/selected/https.mjs';
import { controllerState } from '../cron-probe/selected/observations.mjs';

export async function diagnosticFixtures(host) {
  const request = await httpsClient(host);
  await waitFor('diagnostic owner API', async () => (await request('/v1/admin')).status === 200);
  const token = (await host.json(['admin', 'issue-token', 'diagnostic-builder', 'baseline,peer'])).token;
  const fixture = { request, tokens: { builder: token }, secrets: {}, projects: {}, approvals: {}, submissions: [] };
  for (const app of ['baseline', 'peer']) {
    const project = await writeFixture(host, app); fixture.projects[app] = project;
    fixture.secrets[app] = randomBytes(32).toString('hex');
    await writeFile(join(project, 'env.ts'), "import { defineEnv, string } from 'void/env';\nexport default defineEnv({ DIAGNOSTIC_SECRET: string() });\n");
    await diagnosticHandler(project, app, app === 'baseline');
    const submitted = await submitDiagnostic(host, fixture, app);
    const revision = (await host.json(['admin', 'secrets', app], { inputText: JSON.stringify({ DIAGNOSTIC_SECRET: fixture.secrets[app] }) })).revision;
    await host.command(['admin', 'approve', submitted.id, submitted.digest, revision]);
    const state = await controllerState(host), active = state.deployments[submitted.id];
    assert.equal(active.status, 'active'); assert.equal(active.secretRevision, revision);
    fixture.approvals[app] = { ...submitted, slot: state.apps[app].slot, secretRevision: revision };
    const written = await request('/api/write-probe', { app, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: `${app}-record` }) });
    assert.equal(written.status, 200);
  }
  await writeFile(join(host.output, 'private-diagnostic-config.json'), JSON.stringify(fixture.secrets) + '\n', { mode: 0o600, flag: 'wx' });
  return fixture;
}

export function diagnosticHandler(project, app, failing) {
  return writeFile(join(project, 'routes/api/diagnostic.ts'), `import { defineHandler } from 'void';
export const GET = defineHandler(c => {
  console.log('fogd-diagnostic-${app}', c.env.DIAGNOSTIC_SECRET);
  return c.json({ app: '${app}', responseMarker: 'diagnostic-response-${app}' }, ${failing ? 500 : 200});
});\n`);
}

export async function submitDiagnostic(host, fixture, app) {
  const submitted = await host.json(['deploy', '--name', app], { env: { ...host.env, FOGD_DEPLOY_TOKEN: fixture.tokens.builder }, cwd: fixture.projects[app] });
  assert.equal(submitted.status, 'pending'); fixture.submissions.push(submitted); return submitted;
}
