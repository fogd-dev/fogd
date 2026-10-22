import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, symlink, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { selectedTrial } from './selected-trial.mjs';
import { httpsClient, waitFor } from './https.mjs';
import { expectRefusal } from './evidence.mjs';
import { approveRefresh } from './background-fixtures.mjs';
import { scanPublicSurfaces, assertNoSecrets } from './privacy.mjs';
import { stopSelectedHost } from './shutdown.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
await selectedTrial(process.argv[2], 'Owner application inspection: failed SQL, corrected approval, and recorded cron pause on the frozen local two-fleet image. No live health or application-outcome inference.', async context => {
  const { source: host, evidence } = context, request = await httpsClient(host);
  await waitFor('inspection owner API', async () => (await request('/v1/admin')).status === 200);
  const token = (await host.json(['admin', 'issue-token', 'inspection-builder', 'baseline,refresh'])).token;
  const fixture = { tokens: { builder: token }, secret: randomBytes(32).toString('hex') };
  context.phase = 'ordinary-failure-and-correction';
  const ordinary = await ordinaryInspection(host, request, token, evidence);
  context.phase = 'recorded-cron-pause';
  const refresh = await cronInspection(host, request, fixture, evidence);
  evidence.privacy = await scanPublicSurfaces(host, request, [...ordinary, refresh], token, [fixture.secret], evidence);
  context.phase = 'clean-shutdown'; evidence.shutdown = await stopSelectedHost(host); host.closed = true;
  assert.equal(evidence.shutdown.retainedVolumes.length, 8);
  return fixture;
}, 'public');

async function copyFixture(host, name) {
  const project = join(host.output, `${name}-source`); await mkdir(project);
  const prefix = `examples/${name}/`, execute = promisify(execFile);
  const tracked = (await execute('git', ['ls-files', '-z', '--', `examples/${name}`], { cwd: repo })).stdout.split('\0').filter(Boolean);
  assert.ok(tracked.length > 0);
  for (const path of tracked) {
    const target = join(project, path.slice(prefix.length));
    await mkdir(dirname(target), { recursive: true }); await copyFile(join(repo, path), target);
  }
  await symlink(join(repo, `examples/${name}/node_modules`), join(project, 'node_modules'), 'dir');
  return project;
}
async function inspectWithoutMutation(host, request, name) {
  const snapshot = async () => {
    const response = await request('/v1/admin'); assert.equal(response.status, 200);
    return { raw: response.json(), adminResponseBytes: Buffer.byteLength(response.text) };
  };
  const before = await snapshot(), view = await host.json(['admin', 'inspect', name]), after = await snapshot();
  assert.deepEqual(after.raw, before.raw);
  assert.equal(view.runtimeHealth, 'not-observed'); assert.equal(view.applicationOutcomes, 'not-observed');
  return { ...before, view };
}
async function ordinaryInspection(host, request, token, evidence) {
  const project = await copyFixture(host, 'guestbook');
  const migration = join(project, 'db/migrations/20261016160656_complete_ser_duncan.sql');
  const original = await readFile(migration, 'utf8'), marker = 'PRIVATE_INSPECTION_SQL_MARKER';
  const deploy = () => host.json(['deploy', '--name', 'baseline'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token }, cwd: project, timeout: 240000 });
  await writeFile(migration, `${marker};\n`);
  const bad = await deploy(); assert.equal(bad.status, 'pending'); evidence.bad = bad;
  evidence.pending = await inspectWithoutMutation(host, request, 'baseline');
  assert.equal(evidence.pending.view.routing, 'unassigned'); assert.equal(evidence.pending.view.active, null);
  assert.equal((await request('/api/messages', { app: 'baseline' })).status, 404);
  evidence.failedApproval = await expectRefusal(host, ['admin', 'approve', bad.id, bad.digest], /Activation failed/);
  evidence.failed = await inspectWithoutMutation(host, request, 'baseline');
  const failed = evidence.failed.view, release = failed.releases.find(value => value.id === bad.id), raw = evidence.failed.raw;
  assert.equal(failed.routing, 'paused'); assert.equal(release.status, 'failed'); assert.equal(release.step, 'migrating');
  assert.equal(release.hasPrivateDiagnostic, true); assert.match(raw.deployments[bad.id].error, new RegExp(marker));
  const uncertain = raw.apps.baseline.uncertain;
  assert.deepEqual(failed.uncertainMigration, uncertain ? { id: uncertain, digest: raw.deployments[uncertain].digest } : null);
  assertNoSecrets([JSON.stringify(failed)], [marker]);
  await writeFile(migration, original);
  const good = await deploy(); assert.notEqual(good.digest, bad.digest); evidence.good = good;
  assert.equal((await host.json(['admin', 'approve', good.id, good.digest])).status, 'active');
  evidence.active = await inspectWithoutMutation(host, request, 'baseline');
  const active = evidence.active.view;
  assert.deepEqual(active.active, { id: good.id, digest: good.digest }); assert.equal(active.routing, 'active'); assert.equal(active.uncertainMigration, null);
  assert.equal(active.releases.find(value => value.id === bad.id).status, 'superseded');
  const result = await request('/api/messages', { app: 'baseline' }); assert.equal(result.status, 200); assert.deepEqual(result.json(), []);
  evidence.applicationStatus = result.status;
  return [bad, good];
}
async function cronInspection(host, request, fixture, evidence) {
  const project = await copyFixture(host, 'refresh');
  const submitted = await host.json(['deploy', '--name', 'refresh'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: fixture.tokens.builder }, cwd: project, timeout: 240000 });
  const approved = await approveRefresh(host, submitted, fixture.secret);
  evidence.cron = await inspectWithoutMutation(host, request, 'refresh');
  const { view, raw } = evidence.cron, control = view.controls.dispatch;
  assert.equal(view.routing, 'active'); assert.deepEqual(view.active, { id: submitted.id, digest: submitted.digest });
  assert.equal(view.releases[0].secretRevisionSelected, true);
  assert.equal(control.desired, 'paused'); assert.equal(control.recordedObserved, 'paused');
  assert.equal(control.recordedObservedAt, raw.apps.refresh.dispatch.observedAt);
  assert.ok(Number.isFinite(Date.parse(control.recordedObservedAt)));
  assert.equal(control.hold, null); assert.equal(control.operation, null);
  assertNoSecrets([JSON.stringify(view)], [fixture.secret, approved.version, approved.secretRevision]);
  return submitted;
}
