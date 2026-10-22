import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { selectedHostTrial } from './selected-trial.mjs';
import { copyFixture } from './project-copy.mjs';
import { httpsClient, scopedClient, waitFor } from './https.mjs';
import { expectRefusal } from './evidence.mjs';
import { assertNoSecrets, scanPublicSurfaces } from './privacy.mjs';
import { stopSelectedHost } from './shutdown.mjs';

await selectedHostTrial(process.argv[2], 'Submitter deployment diagnosis on the frozen two-fleet runtime: pending, failed migration, corrected active release, other-submitter/app refusal, and read-only private-field filtering. No live app-health or application-log interface.', async context => {
  const { source: host, evidence } = context, request = await httpsClient(host);
  await waitFor('submitter status owner API', async () => (await request('/v1/admin')).status === 200);
  const builder = (await host.json(['admin', 'issue-token', 'status-builder', 'baseline'])).token;
  const other = (await host.json(['admin', 'issue-token', 'status-other', 'baseline,replacement'])).token;
  const marker = 'PRIVATE_SUBMITTER_SQL_MARKER', fixture = { tokens: { builder, other }, secret: builder };
  const project = await copyFixture(host, 'guestbook', 'status-guestbook');
  const migration = join(project, 'db/migrations/20261016160656_complete_ser_duncan.sql'), original = await readFile(migration, 'utf8');
  const deploy = (name, token) => host.json(['deploy', '--name', name], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token }, cwd: project, timeout: 240000 });
  context.phase = 'pending-and-failed-submission';
  await writeFile(migration, `${marker};\n`);
  const bad = await deploy('baseline', builder); evidence.pending = await unchangedStatus(host, request, bad, builder);
  assert.equal(evidence.pending.report.status, 'pending'); assert.equal(evidence.pending.report.step, 'submitted'); assert.equal(evidence.pending.report.error, null);
  await expectRefusal(host, ['admin', 'approve', bad.id, bad.digest], /Activation failed/);
  const raw = (await request('/v1/admin')).json().deployments[bad.id]; assert.match(raw.error, new RegExp(marker));
  evidence.failed = await unchangedStatus(host, request, bad, builder);
  assert.equal(evidence.failed.report.status, 'failed'); assert.equal(evidence.failed.report.step, 'migrating');
  assert.equal(evidence.failed.report.error, 'A database migration failed or was interrupted. Ask an administrator to inspect the migration before retrying.');
  assertNoSecrets([JSON.stringify(evidence.failed)], [marker, builder, other]);
  context.phase = 'corrected-release';
  await writeFile(migration, original);
  const good = await deploy('baseline', builder); await host.json(['admin', 'approve', good.id, good.digest]);
  evidence.corrected = await unchangedStatus(host, request, good, builder);
  assert.equal(evidence.corrected.report.status, 'active'); assert.equal(evidence.corrected.report.error, null);
  const messages = await request('/api/messages', { app: 'baseline' }); assert.equal(messages.status, 200); assert.deepEqual(messages.json(), []);
  evidence.application = { httpStatus: messages.status, rows: messages.json() };
  context.phase = 'credential-boundary';
  const foreign = await deploy('replacement', other);
  evidence.refusals = [];
  for (const [submitted, token] of [[foreign, builder], [good, other]]) {
    evidence.refusals.push(await expectRefusal({ command: args => host.command(args, { env: { ...host.env, FOGD_DEPLOY_TOKEN: token } }) }, ['status', submitted.id], /unavailable to this deploy credential/));
  }
  const view = await scopedClient(host, builder), forbidden = await view(`/v1/deployments/${foreign.id}`);
  assert.equal(forbidden.status, 404); evidence.foreignHTTPStatus = forbidden.status;
  evidence.privacy = await scanPublicSurfaces(host, request, [bad, good], builder, [other], evidence);
  evidence.shutdown = await stopSelectedHost(host); host.closed = true; assert.equal(evidence.shutdown.retainedVolumes.length, 8);
  assertNoSecrets([JSON.stringify(evidence)], [marker]);
  return fixture;
});

async function unchangedStatus(host, request, release, token) {
  const before = (await request('/v1/admin')).json();
  const report = await host.json(['status', release.id], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token } });
  const after = (await request('/v1/admin')).json(); assert.deepEqual(after, before);
  const view = await scopedClient(host, token), response = await view(`/v1/deployments/${release.id}`); assert.equal(response.status, 200);
  assert.deepEqual(report, response.json()); assert.equal(report.id, release.id); assert.equal(report.digest, release.digest);
  const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { report, controllerBeforeSha256: sha(before), controllerAfterSha256: sha(after), wireStatus: response.status };
}
