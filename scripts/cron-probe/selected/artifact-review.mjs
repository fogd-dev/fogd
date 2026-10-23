import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { artifactDigest } from '../../../packages/runtime/src/artifact.mjs';
import { selectedHostTrial } from './selected-trial.mjs';
import { copyFixture } from './project-copy.mjs';
import { httpsClient, waitFor } from './https.mjs';
import { expectRefusal } from './evidence.mjs';
import { scanPublicSurfaces } from './privacy.mjs';
import { stopSelectedHost } from './shutdown.mjs';

await selectedHostTrial(process.argv[2], 'Read-only operator artifact review: first submission, proposed versus active files and migrations, verified readable copies, unchanged controller state, no SQL effect before separate exact approval, current-release comparison and deploy-only refusal. Frozen local two-fleet family; no runtime, admission or approval changes.', async context => {
  const { source: host, evidence } = context, request = await httpsClient(host);
  await waitFor('artifact review controller', async () => (await request('/v1/admin')).status === 200);
  const token = (await host.json(['admin', 'issue-token', 'review-builder', 'baseline'])).token;
  const fixture = { tokens: { builder: token }, secret: token };
  const project = await copyFixture(host, 'guestbook', 'review-guestbook');
  const migration = join(project, 'db/migrations/20261016160656_complete_ser_duncan.sql');
  await writeFile(migration, (await readFile(migration, 'utf8')) + "\nINSERT INTO messages(id,text,created_at) VALUES(1,'before-review','2026-10-22 12:00:00');\n");
  context.phase = 'first-submission-review';
  const first = await host.json(['deploy', '--name', 'baseline'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token }, cwd: project });
  evidence.first = first; evidence.firstReview = await unchangedReview(host, request, first, join(host.output, 'first-review'));
  assert.equal(evidence.firstReview.report.active, null); assert.ok(evidence.firstReview.report.comparison.files.every(file => file.change === 'added'));
  await host.json(['admin', 'approve', first.id, first.digest]);
  evidence.initialRows = await rows(request); assert.deepEqual(evidence.initialRows.map(row => row.text), ['before-review']);
  context.phase = 'proposed-update-review';
  const name = '20261022202020_review_insert.sql', sql = "INSERT INTO messages(id,text,created_at) VALUES(2,'only-after-approval','2026-10-22 12:00:01');\n";
  await writeFile(join(project, 'db/migrations', name), sql);
  await writeFile(join(project, 'routes/api/hello.ts'), "import {defineHandler} from 'void';\nexport const GET=defineHandler(()=>({version:'reviewed-update'}));\n");
  const second = await host.json(['deploy', '--name', 'baseline'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token }, cwd: project });
  evidence.second = second; const directory = join(host.output, 'update-review');
  evidence.updateReview = await unchangedReview(host, request, second, directory);
  const report = evidence.updateReview.report;
  assert.deepEqual(report.active, { id: first.id, digest: first.digest }); assert.equal(report.proposed.status, 'pending');
  assert.deepEqual(report.comparison.changedDeclarations.resources, []);
  assert.deepEqual(report.comparison.changedDeclarations.requiredSecrets, { added: [], removed: [] });
  assert.equal(report.proposed.submitter.name, 'review-builder');
  const added = report.comparison.files.filter(file => file.path.endsWith('/' + name)); assert.equal(added.length, 1); assert.equal(added[0].change, 'added');
  assert.equal(await readFile(join(directory, 'proposed', added[0].path), 'utf8'), sql);
  assert.equal(await artifactDigest(join(directory, 'active')), first.digest); assert.equal(await artifactDigest(join(directory, 'proposed')), second.digest);
  evidence.beforeApprovalRows = await rows(request); assert.deepEqual(evidence.beforeApprovalRows, evidence.initialRows);
  evidence.existingOutputRefusal = await expectRefusal(host, ['admin', 'review', second.id, '--output', directory], /output already exists/);
  evidence.deployOnlyRefusal = await expectRefusal({ command: args => host.command(args, { env: { ...host.env, FOGD_ADMIN_PASSWORD: '', FOGD_DEPLOY_TOKEN: token } }) }, ['admin', 'review', second.id, '--output', join(host.output, 'deploy-only-review')], /Set FOGD_ADMIN_PASSWORD/);
  await assert.rejects(access(join(host.output, 'deploy-only-review')), { code: 'ENOENT' });
  context.phase = 'separate-exact-approval';
  const saved = await readFile(join(directory, 'review.json'));
  await host.json(['admin', 'approve', second.id, second.digest]);
  evidence.afterApprovalRows = await rows(request); assert.deepEqual(evidence.afterApprovalRows.map(row => row.text).sort(), ['before-review', 'only-after-approval']);
  assert.deepEqual(await readFile(join(directory, 'review.json')), saved);
  evidence.currentReview = await unchangedReview(host, request, second, join(host.output, 'current-review'));
  assert.equal(evidence.currentReview.report.proposed.status, 'active'); assert.deepEqual(evidence.currentReview.report.comparison.files, []);
  evidence.privacy = await scanPublicSurfaces(host, request, [first, second], token, [], evidence);
  evidence.shutdown = await stopSelectedHost(host); host.closed = true; assert.equal(evidence.shutdown.retainedVolumes.length, 8);
  return fixture;
});

async function unchangedReview(host, request, release, output) {
  const before = (await request('/v1/admin')).json();
  const report = await host.json(['admin', 'review', release.id, '--output', output]);
  const after = (await request('/v1/admin')).json(); assert.deepEqual(after, before);
  const hash = state => createHash('sha256').update(JSON.stringify(state)).digest('hex');
  assert.equal(report.proposed.id, release.id); assert.equal(report.proposed.digest, release.digest);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'review.json'))), Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'directory')));
  return { report, controllerBeforeSha256: hash(before), controllerAfterSha256: hash(after) };
}
async function rows(request) {
  const result = await request('/api/messages', { app: 'baseline' }); assert.equal(result.status, 200); return result.json();
}
