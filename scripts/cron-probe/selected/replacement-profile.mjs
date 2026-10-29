import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedHost, cleanupSelectedHost } from './host.mjs';
import { replacementFixtures } from './replacement-fixtures.mjs';
import { approveOffline, offlineSurfaces } from './offline-fixtures.mjs';
import { nativeObservation, vmTime } from './observations.mjs';
import { archiveSources, sourceInventory, sourceState } from './evidence.mjs';
import { failureDiagnosticReceipt } from './failure-receipt.mjs';
import { failureObserver } from './failure-observer.mjs';
import { replacementObserver } from './replacement-observer.mjs';
import { interruptedReplacement } from './replacement-interruption.mjs';
import { migrationOverlap } from './replacement-migration.mjs';
import { replacementLostReply } from './replacement-retry.mjs';
import { assertReplacementHistory } from './replacement-history.mjs';
import { browserState } from './failure-browser.mjs';
import { waitFailureTime } from './failure-phases.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { importJob } from './background-fixtures.mjs';
import { waitFor } from './https.mjs';
import { rows } from './recovery-ledger.mjs';
import { verifiedObservationKeys } from './failure-authority.mjs';
import { openControllerDebugger, killController } from './controller-debugger.mjs';
import { checkedNativeDefaults, verifyNativeTimingEnvironment } from '../sealed/defaults.mjs';
import { requestedRuntime } from '../../../packages/cli/src/runtime/catalog.mjs';
import { translateConfig } from '../../../packages/runtime/src/artifact.mjs';
import { qualificationInputs } from './qualification-inputs.mjs';
import { offlineImage, checkOfflineInputs } from '../offline-build.mjs';

const inputs = qualificationInputs(process.argv.slice(2));
await checkOfflineInputs(inputs.hostOptions.sdkImage || offlineImage);
const provenance = await sourceState(), sources = await sourceInventory(), host = await selectedHost(inputs.output, 'candidate', undefined, inputs.hostOptions);
const evidence = {}, clock = () => vmTime(host, host.policy.fleets[1].nodes[0].host);
const publication = { path: 'packages/platform/src/activation.mjs', marker: 'request.version = await controller.backend.publish(slot, execution);', functionName: 'publish' };
let phase = 'builds', reader, session, failure;
const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  await archiveSources(host.output, provenance, sources, new URL(import.meta.url));
  evidence.defaults = await checkedNativeDefaults();
  evidence.timingEnvironment = await verifyNativeTimingEnvironment({ ...host, slots: host.policy.fleets.map(fleet => ({ nodes: fleet.nodes.map(node => node.host) })) });
  const fixture = await replacementFixtures(host);
  host.nativeBaseline = await nativeProcesses(host);
  evidence.builds = Object.fromEntries(Object.entries(fixture.builds).map(([name, build]) => [name, build.verification]));
  phase = 'initial-approval'; const active = await approveOffline(host, fixture, 'old');
  evidence.initial = await nativeObservation(host, active.slot, active.id, { captureProofs: true });
  const keys = verifiedObservationKeys(host.policy, active.slot, evidence.initial);
  const legacy = await failureObserver(host, active); evidence.legacyReader = legacy.inspect;
  try { evidence.legacyPreparation = await legacy.observe('prepared-state', { keys }); } finally { await legacy.close(); }
  reader = await replacementObserver(host, active); evidence.reader = reader.inspect; evidence.initialLedger = await reader.observe();
  const imported = fixture.approvals.imports; await importJob(fixture.request, 'replacement-control', 'kiwi\nlime');
  evidence.untouchedBefore = await waitFor('untouched imports complete', async () => {
    const value = await nativeObservation(host, imported.slot, imported.id, { captureProofs: true });
    return rows(value, 'import_jobs').some(row => row.id === 'replacement-control' && row.status === 'complete') && rows(value, 'import_results').filter(row => row.job_id === 'replacement-control').length === 2 && value;
  });
  const container = (await host.run('docker', ['inspect', '--format', '{{.Id}}', `${host.project}-controller-1`])).trim();
  session = await openControllerDebugger(container, host.project, host.entry.id);
  const checkpoint = await session.debuggerSession.breakpoint(publication);
  phase = 'migration-overlap'; evidence.migration = {};
  const updated = await migrationOverlap({ host, fixture, active, reader, debuggerSession: session.debuggerSession, checkpoint, evidence: evidence.migration });
  await reader.close(); reader = await replacementObserver(host, updated); evidence.updatedReader = reader.inspect;
  const finalCheckpoint = await session.debuggerSession.breakpoint(publication);
  phase = 'interrupted-callbacks'; evidence.interruption = {};
  const final = await interruptedReplacement({ host, fixture, active: updated, reader, debuggerSession: session.debuggerSession, checkpoint: finalCheckpoint, defaults: evidence.defaults, evidence: evidence.interruption });
  await session.debuggerSession.close(); session = null; await reader.close(); reader = await replacementObserver(host, final);
  phase = 'lost-acknowledgment'; evidence.retry = {}; await replacementLostReply({ host, fixture, active: final, reader, clock, evidence: evidence.retry });
  const paused = await host.json(['admin', 'dispatch', 'refresh', 'pause']); assert.equal(paused.observed, 'paused');
  evidence.finalPauseAt = Date.parse(paused.observedAt); assert.ok(Number.isSafeInteger(evidence.finalPauseAt));
  evidence.final = await reader.observe(); assert.equal(evidence.final.info.paused, true);
  const old = evidence.migration.completed.attempts.find(row => row.id === evidence.migration.oldHeld.id);
  assert.deepEqual(evidence.final.attempts.find(row => row.id === old.id), old);
  evidence.finalHeld = { first: evidence.final, target: (Math.floor(evidence.finalPauseAt / 60000) + 1) * 60000 + evidence.defaults.operationDeadlineMs + 5000 };
  phase = 'final-held-minute'; await waitFailureTime(clock, evidence.finalHeld.target);
  evidence.final = await reader.observe(); assert.equal(evidence.final.info.paused, true); assert.equal(evidence.final.info.nextAlarm, null);
  evidence.finalHeld.end = evidence.final.completedAt;
  for (const table of ['attempts', 'results', 'occurrences', 'control']) assert.deepEqual(evidence.final[table], evidence.finalHeld.first[table]);
  evidence.history = assertReplacementHistory(evidence, evidence.final);
  const response = await fixture.request('/api/refresh', { app: 'refresh' }); assert.equal(response.status, 200); evidence.summary = response.json();
  assert.deepEqual(evidence.summary.unfinished.map(row => [row.job, row.scheduled_time]), [['advisory', evidence.interruption.time]]); assert.equal(evidence.summary.unfinishedCount, 1);
  const saved = evidence.final.results.find(row => row.job === 'advisory' && row.scheduled_time === evidence.retry.time + 60000); assert.ok(saved);
  const inventory = evidence.final.results.find(row => row.job === 'inventory' && row.scheduled_time === evidence.retry.time + 60000); assert.ok(inventory);
  phase = 'unfinished-browser'; evidence.browser = await browserState(host, 'replacement', saved, { unfinished: evidence.summary.unfinished[0], inventory });
  evidence.untouchedAfter = await nativeObservation(host, imported.slot, imported.id, { captureProofs: true }); assert.deepEqual(evidence.untouchedAfter.databases, evidence.untouchedBefore.databases);
  assert.deepEqual(verifiedObservationKeys(host.policy, imported.slot, evidence.untouchedAfter), verifiedObservationKeys(host.policy, imported.slot, evidence.untouchedBefore));
  evidence.statuses = [];
  for (const [index, submitted] of fixture.submissions.refresh.entries()) {
    const status = await host.json(['status', submitted.id], { env: { ...host.env, FOGD_DEPLOY_TOKEN: fixture.tokens.refresh } });
    assert.equal(status.status, index === 2 ? 'active' : 'superseded'); assert.equal(status.digest, submitted.digest); evidence.statuses.push(status);
  }
  assert.equal(evidence.statuses.length, 3); assert.throws(() => requestedRuntime({ runtime: host.entry.id }), /ordinary enrollment remains closed/);
  for (const build of Object.values(fixture.builds)) assert.throws(() => translateConfig(build.verification.native, 'refresh'), /Unsupported binding\/config: triggers/);
  await reader.close(); reader = null; phase = 'shutdown';
  await failureDiagnosticReceipt(host, fixture, { scope: 'Selected local Linux arm64 replacement profile: ordinary offline artifacts, scoped HTTPS approval, compatible migration overlap, interrupted callbacks, native generation release, original-occurrence lost-ack retries and unfinished browser state. Retirement, complete M11c acceptance and public admission remain open.', provenance, sources, evidence }, await offlineSurfaces(host, fixture));
  console.log('PASS-selected-replacement-profile-only');
} catch (error) {
  failure = error;
  try { await writeFile(join(host.output, 'failure.json'), JSON.stringify({ phase, name: error.name, message: error.message, cause: error.cause?.message, evidence }, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (recordError) { console.error('Could not retain failure record:', recordError.message); }
  throw error;
} finally {
  clearInterval(heartbeat); const errors = [];
  try { if (reader) await reader.close(); } catch (error) { errors.push(error); }
  try { if (session) await killController(session.identity); } catch (error) { errors.push(error); }
  try { if (!host.closed) await cleanupSelectedHost(host); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], 'Replacement qualification cleanup failed');
}
