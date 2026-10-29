import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { selectedHost, cleanupSelectedHost } from './host.mjs';
import { httpsClient, waitFor, crossMinute } from './https.mjs';
import { controllerState, nativeObservation } from './observations.mjs';
import { openControllerDebugger, killController } from './controller-debugger.mjs';
import { archiveSources, sourceInventory, sourceState, expectRefusal, assertEmptyJobs, assertActive } from './evidence.mjs';
import { scanPublicSurfaces } from './privacy.mjs';
import { qualificationInputs } from './qualification-inputs.mjs';
import { stopSelectedHost } from './shutdown.mjs';
import { restartInterruptedController } from './controller-restart.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const inputs = qualificationInputs(process.argv.slice(2));
const provenance = await sourceState(), sources = await sourceInventory(), host = await selectedHost(inputs.output, 'candidate', undefined, inputs.hostOptions), events = [];
let phase = 'https-ready', session, closed = false;
const note = (name, value = {}) => { events.push({ at: Date.now(), name, ...value }); console.log(name); };
const save = (name, value) => writeFile(join(host.output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  await archiveSources(host.output, provenance, sources, new URL(import.meta.url));
  const request = await httpsClient(host);
  await waitFor('HTTPS admin', async () => (await request('/v1/admin')).status === 200);
  await waitFor('signed native bootstrap', async () => {
    const observations = [];
    for (const fleet of host.policy.fleets) observations.push(await nativeObservation(host, fleet.id));
    return observations.every(value => value.bootstrapVerified && value.count === 0 && value.truncated === false);
  });
  const token = await host.json(['admin', 'issue-token', 'activation-builder', 'refresh']);
  const submitted = await host.json(['deploy', '--name', 'refresh'], { env: { ...host.env, FOGD_DEPLOY_TOKEN: token.token }, cwd: join(repo, 'examples/refresh') });
  assert.equal(submitted.status, 'pending');
  phase = 'unapproved-minute'; const unapprovedMinute = await crossMinute();
  const unpublished = [];
  for (const fleet of host.policy.fleets) unpublished.push(await nativeObservation(host, fleet.id));
  assert.ok(unpublished.every(value => value.count === 0 && value.truncated === false && value.keys.length === 0));
  note('unapproved-minute-unpublished', { unapprovedMinute, unpublished });
  const initialSecretValue = randomBytes(32).toString('hex');
  const revision = (await host.json(['admin', 'secrets', 'refresh'], { inputText: JSON.stringify({ REFRESH_TOKEN: initialSecretValue }) })).revision;
  const container = (await host.run('docker', ['inspect', '--format', '{{.Id}}', `${host.project}-controller-1`])).trim();
  session = await openControllerDebugger(container, host.project, host.entry.id);
  const migration = await session.debuggerSession.breakpoint({ path: 'packages/platform/src/backend.mjs', marker: "for (const db of resources.d1) await this.run(slot, ['d1', 'migrations'", functionName: 'migrate' });
  phase = 'approval-migration-pause';
  // Settle the CLI result immediately on either outcome; a killed request is
  // expected later, while an early failure must never be an unhandled rejection.
  let approvalSettled = false;
  const approval = host.command(['admin', 'approve', submitted.id, submitted.digest, revision], { timeout: 240000 }).then(
    () => { approvalSettled = true; return { ok: true, at: Date.now() }; },
    () => { approvalSettled = true; return { ok: false, at: Date.now() }; },
  );
  const migrationPause = await session.debuggerSession.paused(migration);
  const before = await migrationSnapshot(host, submitted, revision);
  session.debuggerSession.assertPaused(migrationPause.pauseSequence);
  phase = 'held-migration-minute'; const migrationMinute = await crossMinute();
  const after = await migrationSnapshot(host, submitted, revision);
  session.debuggerSession.assertPaused(migrationPause.pauseSequence);
  assert.deepEqual(after, before);
  await save('migration-pause.json', { migrationPause, migrationMinute, before, after }); note('migration-minute-held-without-application-schema');
  const publication = await session.debuggerSession.breakpoint({ path: 'packages/platform/src/activation.mjs', marker: "await step('waiting-for-replicas');", functionName: 'publish' });
  await session.debuggerSession.remove(migration); await session.debuggerSession.resume();
  phase = 'publication-pause'; const publicationPause = await session.debuggerSession.paused(publication);
  const publishedState = await controllerState(host), app = publishedState.apps.refresh, attempt = publishedState.deployments[submitted.id];
  assert.equal(attempt.step, 'publishing'); assert.equal(attempt.secretRevision, revision);
  assert.equal(app.dispatch.hold, submitted.id); assert.equal(app.dispatch.observed, 'paused'); assert.equal(app.uncertain, null);
  const nativePublished = await nativeObservation(host, app.slot, submitted.id);
  assert.equal(nativePublished.status.paused, true); assert.equal(nativePublished.status.nextAlarm, null);
  assert.deepEqual(nativePublished.stored.manifest.crons, attempt.resources.crons);
  assert.notEqual(nativePublished.stored.manifest.version, before.state.apps.refresh.cronBootstrap.version);
  session.debuggerSession.assertPaused(publicationPause.pauseSequence);
  await save('publication-pause.json', { publicationPause, state: publishedState, native: nativePublished });
  assert.equal(approvalSettled, false); const killRequestedAt = Date.now();
  const interruptedIdentity = session.identity, interruption = await killController(interruptedIdentity);
  // A lost debugger connection after the confirmed daemon kill is expected.
  session = undefined;
  assert.deepEqual(await controllerState(host), publishedState);
  const interruptedApproval = await approval;
  assert.equal(interruptedApproval.ok, false); assert.ok(interruptedApproval.at >= killRequestedAt);
  note('publication-killed-with-durable-state-preserved', { interruption, killRequestedAt, interruptedApproval });
  phase = 'controller-restart'; const restart = await restartInterruptedController(interruptedIdentity);
  const recovered = await waitFor('interrupted approval rehold', async () => {
    const state = await controllerState(host), control = state.apps.refresh.dispatch;
    return state.deployments[submitted.id].status === 'failed' && control.hold === submitted.id && control.observed === 'paused' && control.operation === null && state;
  });
  assert.equal(recovered.deployments[submitted.id].secretRevision, revision);
  const heldNative = await nativeObservation(host, recovered.apps.refresh.slot, submitted.id); assertEmptyJobs(heldNative);
  phase = 'reheld-minute'; const reheldMinute = await crossMinute();
  const afterReheldMinute = await nativeObservation(host, recovered.apps.refresh.slot, submitted.id); assertEmptyJobs(afterReheldMinute);
  await save('reheld-minute.json', { recovered, heldNative, reheldMinute, afterReheldMinute });
  phase = 'explicit-original-retry';
  const changedSecretValue = randomBytes(32).toString('hex');
  const newRevision = (await host.json(['admin', 'secrets', 'refresh'], { inputText: JSON.stringify({ REFRESH_TOKEN: changedSecretValue }) })).revision;
  assert.notEqual(newRevision, revision);
  const beforeRefusal = await controllerState(host);
  const refusal = await expectRefusal(host, ['admin', 'approve', submitted.id, submitted.digest, newRevision], /retries must retain their pinned revision/);
  assert.deepEqual(await controllerState(host), beforeRefusal);
  const retryRequestedAt = Date.now(); await host.command(['admin', 'approve', submitted.id, submitted.digest, revision]); const approvalReturnedAt = Date.now();
  const active = await controllerState(host); assertActive(active, submitted, revision);
  phase = 'autonomous-future-minute'; await crossMinute();
  const autonomous = await waitFor('future jobs before app HTTP', async () => {
    const observation = await nativeObservation(host, recovered.apps.refresh.slot, submitted.id);
    const records = observation.databases.flatMap(database => database.data.refresh_occurrences || []);
    return ['inventory', 'advisory'].every(job => records.some(row => row.job === job && row.status === 'complete' && row.scheduled_time > approvalReturnedAt)) && observation;
  }, 120000);
  const occurrences = autonomous.databases.flatMap(database => database.data.refresh_occurrences || []);
  assert.ok(occurrences.every(row => row.scheduled_time >= retryRequestedAt));
  const firstAppReadAt = Date.now(), firstAppRead = await request('/api/refresh', { app: 'refresh' }); assert.equal(firstAppRead.status, 200);
  const identities = [];
  for (const fleet of host.policy.fleets) identities.push(await nativeObservation(host, fleet.id, undefined, { captureProofs: true }));
  const receipt = { scope: 'Selected frozen-image migration hold and publication interruption; other M11c gates remain open', project: host.project, family: host.entry.id, image: host.entry.image,
    policy: host.policy, submitted, revision, publishedVersion: nativePublished.stored.manifest.version, provenance, sources, interruption, restart, refusal, active, retryRequestedAt, approvalReturnedAt, firstAppReadAt, autonomous, firstAppRead: firstAppRead.json(), identities, events };
  receipt.privacy = await scanPublicSurfaces(host, request, [submitted], token.token, [initialSecretValue, changedSecretValue], receipt);
  phase = 'retained-shutdown'; receipt.shutdown = await stopSelectedHost(host); closed = true;
  assert.deepEqual(await sourceInventory(), sources); assert.deepEqual(await sourceState(), provenance);
  await save('result.json', receipt); note('PASS-selected-migration-and-publication-slice');
} catch (error) {
  await save('failure.json', { phase, name: error.name, message: error.message, events });
  if (session) { await killController(session.identity); session = undefined; }
  throw error;
} finally {
  clearInterval(heartbeat);
  try { if (session) await session.debuggerSession.close(); } finally { if (!closed) await cleanupSelectedHost(host); }
}

async function migrationSnapshot(host, submitted, revision) {
  const state = await controllerState(host), app = state.apps.refresh, attempt = state.deployments[submitted.id];
  assert.equal(attempt.step, 'migrating'); assert.equal(attempt.status, 'activating'); assert.equal(attempt.secretRevision, revision);
  assert.equal(app.uncertain, submitted.id); assert.equal(app.cronBootstrap.phase, 'ready');
  assert.equal(app.dispatch.hold, submitted.id); assert.equal(app.dispatch.observed, 'paused'); assert.equal(app.dispatch.operation, null);
  const native = await nativeObservation(host, app.slot, submitted.id);
  assert.deepEqual(native.status.crons, []); assert.equal(native.status.paused, true); assert.equal(native.status.nextAlarm, null);
  assert.equal(native.databases.length, 1); assert.deepEqual(native.databases[0].migrations, []);
  assert.deepEqual(native.stored.manifest.crons, []); assert.equal(native.stored.manifest.version, app.cronBootstrap.version);
  assert.ok(native.databases[0].rows.some(row => row.name === 'd1_migrations'));
  assert.ok(native.databases[0].rows.every(row => row.name.startsWith('_') || ['d1_migrations', 'sqlite_sequence'].includes(row.name)));
  return { state, native };
}
