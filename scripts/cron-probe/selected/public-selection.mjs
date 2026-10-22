import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectedTrial } from './selected-trial.mjs';
import { httpsClient, waitFor, crossMinute } from './https.mjs';
import { controllerState, nativeObservation, vmTime } from './observations.mjs';
import { fleetProofs, preserveSnapshots } from './retirement-steps.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { publicTarget } from './public-target.mjs';
import { coldRecovery, acknowledgeRecovery } from './recovery-holds.mjs';
import { heldRetirement } from './retirement-holds.mjs';
import { backgroundSnapshot } from './recovery-snapshot.mjs';
import { resumeCron } from './recovery-work.mjs';
import { heldDataInterval } from './recovery-interval.mjs';
import { applicationData } from './recovery-fixtures.mjs';
import { scanPublicSurfaces } from './privacy.mjs';
import { stopSelectedHost } from './shutdown.mjs';
import { json } from '../../../packages/cli/src/recovery/docker.mjs';
import { expectRefusal, commandRefusal } from './evidence.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
if (process.argv.length !== 3) throw new Error('Usage: node scripts/cron-probe/selected/public-selection.mjs PRIVATE_OUTPUT_DIRECTORY');
await selectedTrial(process.argv[2], 'Public qualified-family selectors on the frozen local two-fleet image; release acceptance remains separately audited', async context => {
  const { source, installations, evidence } = context, request = await httpsClient(source);
  evidence.enrollment = source.enrollment;
  await waitFor('public source admin', async () => (await request('/v1/admin')).status === 200);
  evidence.bootstrap = await waitFor('public source native proofs', () => fleetProofs(source, true));
  const token = (await source.json(['admin', 'issue-token', 'public-builder', 'refresh'])).token;
  const secret = randomBytes(32).toString('hex'), fixture = { tokens: { refresh: token }, secret, approvals: {} };
  const submitted = await source.json(['deploy', '--name', 'refresh'], { env: { ...source.env, FOGD_DEPLOY_TOKEN: token }, cwd: join(repo, 'examples/refresh') });
  assert.equal(submitted.status, 'pending'); context.phase = 'public-unapproved-minute';
  evidence.unapprovedMinute = await crossMinute(); evidence.unpublished = await fleetProofs(source, true);
  const revision = (await source.json(['admin', 'secrets', 'refresh'], { inputText: JSON.stringify({ REFRESH_TOKEN: secret }) })).revision;
  const beforeRefusal = await controllerState(source);
  evidence.refusals = {
    missingRevision: await expectRefusal(source, ['admin', 'approve', submitted.id, submitted.digest], /Approval requires an explicit secret revision/),
    wrongRevision: await expectRefusal(source, ['admin', 'approve', submitted.id, submitted.digest, 'unselected-revision'], /Select the current secret revision/),
    scope: await commandRefusal(source.command(['deploy', '--name', 'imports'], { env: { ...source.env, FOGD_DEPLOY_TOKEN: token }, cwd: join(repo, 'examples/imports') }), /outside its app scope/),
  };
  assert.deepEqual(await controllerState(source), beforeRefusal); evidence.refusals.unpublished = await fleetProofs(source, true);
  await source.command(['admin', 'approve', submitted.id, submitted.digest, revision]);
  const state = await controllerState(source), app = state.apps.refresh, approval = state.deployments[app.active];
  assert.equal(approval.id, submitted.id); assert.equal(approval.digest, submitted.digest); assert.equal(approval.secretRevision, revision); assert.equal(approval.status, 'active');
  const active = { ...submitted, slot: app.slot, version: approval.version, secretRevision: revision }; fixture.approvals.refresh = active;
  source.nativeBaseline = await nativeProcesses(source); context.phase = 'public-autonomous-future';
  evidence.sourceReleasedAt = await vmTime(source); evidence.sourceFuture = await futureSaved(source, active, evidence.sourceReleasedAt);
  evidence.firstAppReadAt = await vmTime(source);
  const firstRead = await request('/api/refresh', { app: 'refresh' }); assert.equal(firstRead.status, 200); evidence.firstAppRead = firstRead.json();
  assert.deepEqual(evidence.firstAppRead.jobs.map(view => view.job).sort(), ['advisory', 'inventory']);
  for (const view of evidence.firstAppRead.jobs) assert.ok(view.lastSuccess.scheduled_time > evidence.sourceReleasedAt && typeof view.lastSuccess.value === 'string' && view.lastSuccess.value.length > 0);
  evidence.sourceIdentities = await fleetProofs(source);
  evidence.sourcePrivacy = await scanPublicSurfaces(source, request, [active], token, [secret], evidence);
  context.phase = 'public-paused-minute'; evidence.sourcePause = await pausedMinute(source, active);
  context.phase = 'public-source-backup'; const point = await backgroundSnapshot(source, fixture.approvals, join(source.output, 'source-snapshot'), [], installations);
  evidence.sourceSnapshot = point;
  context.phase = 'public-restore'; const restored = await publicTarget(source, point, join(source.output, 'restored'), installations); installations.push(restored);
  evidence.restore = { project: restored.project, policy: restored.policy, refusals: restored.refusals, initialServices: restored.initialServices, networks: restored.networks };
  context.phase = 'public-cold-restore'; evidence.restore.cold = await coldRecovery(restored, point, installations);
  context.phase = 'public-recovery-acknowledgment'; evidence.restore.acknowledged = await acknowledgeRecovery(restored, point, installations);
  context.phase = 'public-restored-future'; evidence.restore.resumed = await resumeCron(restored, active);
  evidence.restore.future = await futureSaved(restored, active, evidence.restore.resumed.requestedAt);
  evidence.restore.identities = await fleetProofs(restored);
  context.phase = 'public-restored-pause'; evidence.restore.pause = await pausedMinute(restored, active);
  context.phase = 'public-restored-backup'; const second = await backgroundSnapshot(restored, fixture.approvals, join(source.output, 'restored-snapshot'), [], installations);
  evidence.restoredSnapshot = second;
  context.phase = 'public-retirement'; const retired = await publicTarget(restored, second, join(source.output, 'retired'), installations, active); installations.push(retired);
  evidence.retirement = { project: retired.project, policy: retired.policy, plan: retired.retirement, refusals: retired.refusals, initialServices: retired.initialServices, networks: retired.networks };
  context.phase = 'public-retired-holds'; const held = await heldRetirement(retired, second, installations); evidence.retirement.held = held.evidence;
  assert.deepEqual(held.evidence.approvals, {}); evidence.retirement.emptyFleets = await fleetProofs(retired, true);
  evidence.retirement.applicationStatus = (await held.request('/api/refresh', { app: 'refresh' })).status; assert.equal(evidence.retirement.applicationStatus, 404);
  evidence.retirement.privacy = await scanPublicSurfaces(retired, held.request, [active], token, [secret], evidence);
  evidence.retirement.shutdown = await stopSelectedHost(retired); retired.closed = true;
  context.phase = 'public-source-preservation'; evidence.preserved = await preserveSnapshots([{ host: source, point }, { host: restored, point: second }]);
  const volumes = installations.flatMap(host => Object.values(host.config.volumes).map(volume => volume.name));
  assert.equal(volumes.length, 24); assert.equal(new Set(volumes).size, 24);
  const inspected = await json(['volume', 'inspect', ...volumes]); assert.deepEqual(inspected.map(volume => volume.Name).sort(), volumes.toSorted());
  evidence.retainedVolumes = volumes; assert.ok(installations.every(host => host.closed));
  return fixture;
}, 'public');

async function futureSaved(host, active, since) {
  return waitFor('public future saved scheduled jobs', async () => {
    const value = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    const rows = value.databases.flatMap(database => database.data.refresh_occurrences || []), results = value.databases.flatMap(database => database.data.refresh_results || []);
    return ['inventory', 'advisory'].every(job => rows.some(row => row.job === job && row.status === 'complete' && row.scheduled_time > since &&
      results.some(result => result.job === job && result.cron === row.cron && result.scheduled_time === row.scheduled_time))) && value;
  }, 180000);
}

async function pausedMinute(host, active) {
  const journal = await host.json(['admin', 'dispatch', active.app, 'pause']); assert.equal(journal.observed, 'paused'); assert.equal(journal.desired, 'paused');
  const before = await nativeObservation(host, active.slot, active.id, { persistedRecords: true }), startedAt = await vmTime(host);
  const after = await heldDataInterval(host, { approvals: { refresh: active }, before: applicationData({ refresh: before }), until: startedAt + 62000,
    verify: async observed => { assert.deepEqual(observed.refresh.status, before.status); assert.equal(observed.refresh.status.nextAlarm, null); },
  });
  return { journal, before, after, startedAt, endedAt: await vmTime(host) };
}
