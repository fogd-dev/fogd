import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedHost, cleanupSelectedHost } from './host.mjs';
import { offlineFixtures, approveOffline, offlineSurfaces } from './offline-fixtures.mjs';
import { importJob } from './background-fixtures.mjs';
import { nativeObservation, vmTime } from './observations.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { rows } from './recovery-ledger.mjs';
import { beginFailurePhase, firstFailureOccurrence, assertHealthyOccurrence, pauseFailureWork, waitFailureTime } from './failure-phases.mjs';
import { selectedNoRetry, selectedTerminal } from './failure-scheduled-cases.mjs';
import { prepareOwnerWaker } from './failure-waker-preparation.mjs';
import { selectedOwnerLoss } from './failure-owner-case.mjs';
import { selectedDowntime } from './failure-downtime-case.mjs';
import { selectedFailureBrowser, browserState, setFailureSource } from './failure-browser.mjs';
import { failureObserver } from './failure-observer.mjs';
import { FailureAccess } from './failure-access.mjs';
import { verifiedObservationKeys } from './failure-authority.mjs';
import { assertFailureHistory } from './failure-history.mjs';
import { failureDiagnosticReceipt } from './failure-receipt.mjs';
import { sourceInventory, sourceState } from './evidence.mjs';
import { checkedNativeDefaults, verifyNativeTimingEnvironment } from '../sealed/defaults.mjs';
import { requestedRuntime } from '../../../packages/cli/src/runtime/catalog.mjs';
import { translateConfig } from '../../../packages/runtime/src/artifact.mjs';
import { waitFor } from './https.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/cron-probe/selected/failure-profile.mjs NEW_PRIVATE_OUTPUT');
const provenance = await sourceState(), sources = await sourceInventory(), defaults = await checkedNativeDefaults(), host = await selectedHost(process.argv[2]);
const clock = () => vmTime(host, host.policy.fleets[1].nodes[0].host), access = new FailureAccess(host.policy.fleets[1].nodes[0].host); access.install(host);
const evidence = { heldIntervals: [] }; let phase = 'offline-builds', failure, native, storage;
const save = (name, value) => writeFile(join(host.output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  const fixture = await offlineFixtures(host), approvals = []; host.nativeBaseline = await nativeProcesses(host);
  evidence.builds = Object.fromEntries(Object.entries(fixture.builds).map(([name, build]) => [name, build.verification]));
  evidence.timingEnvironment = await verifyNativeTimingEnvironment({ ...host, slots: host.policy.fleets.map(fleet => ({ nodes: fleet.nodes.map(node => node.host) })) });
  evidence.startIdentities = [];
  for (const fleet of host.policy.fleets) {
    const observed = await nativeObservation(host, fleet.id, undefined, { captureProofs: true }); verifiedObservationKeys(host.policy, fleet.id, observed); evidence.startIdentities.push(observed);
  }
  let active = await approveOffline(host, fixture, 'minute'); approvals.push(active); assert.equal(active.slot, host.policy.fleets[0].id);
  await setFailureSource(host, fixture, 'healthy');
  const imported = fixture.approvals.imports; await importJob(fixture.request, 'failure-control', 'kiwi\nlime');
  evidence.untouchedBefore = await waitFor('untouched-fleet business results', async () => {
    const observed = await nativeObservation(host, imported.slot, imported.id, { captureProofs: true, persistedRecords: true });
    return rows(observed, 'import_jobs').some(row => row.id === 'failure-control' && row.status === 'complete') && rows(observed, 'import_results').filter(row => row.job_id === 'failure-control').length === 2 && observed;
  });
  phase = 'baseline'; evidence.baseline = await beginFailurePhase(host, active, 'baseline', clock);
  evidence.baseline.first = await firstFailureOccurrence(host, active, evidence.baseline); assertHealthyOccurrence(evidence.baseline.first);
  evidence.baseline.browserPause = await pauseFailureWork(host, active, clock);
  const baselineSaved = rows(evidence.baseline.browserPause.observed, 'refresh_results').filter(row => row.job === 'advisory').sort((a, b) => a.scheduled_time - b.scheduled_time).at(-1);
  evidence.baseline.browser = await browserState(host, 'baseline', baselineSaved);
  phase = 'no-retry'; evidence.noRetry = {}; await selectedNoRetry({ host, active, clock, evidence: evidence.noRetry }); await save('no-retry.json', evidence.noRetry);
  phase = 'owner-preparation'; const preparationPause = await host.json(['admin', 'dispatch', 'refresh', 'pause']); assert.equal(preparationPause.observed, 'paused');
  native = await failureObserver(host, active); storage = await failureObserver(host, active, 'storage'); evidence.ownerReaders = [native.inspect, storage.inspect];
  evidence.preparation = {}; await prepareOwnerWaker({ host, active, clock, native, storage, defaults, evidence: evidence.preparation });
  phase = 'owner-loss'; evidence.ownerLoss = {}; await selectedOwnerLoss({ host, active, clock, native, storage, defaults, evidence: evidence.ownerLoss }); await save('owner-loss.json', evidence.ownerLoss);
  evidence.heldIntervals.push({ start: Date.parse(preparationPause.observedAt), end: evidence.ownerLoss.phase.held.end });
  await native.close(); native = null; await storage.close(); storage = null;
  evidence.beforeSparse = await pausedSnapshot(active);
  phase = 'sparse-approval'; active = await approveOffline(host, fixture, 'sparse'); approvals.push(active); assert.equal(active.slot, host.policy.fleets[0].id);
  phase = 'terminal'; evidence.terminal = {}; await selectedTerminal({ host, active, clock, defaults, evidence: evidence.terminal }); await save('terminal.json', evidence.terminal);
  evidence.beforeMinuteAgain = await pausedSnapshot(active);
  phase = 'minute-approval'; active = await approveOffline(host, fixture, 'minute'); approvals.push(active); assert.equal(active.slot, host.policy.fleets[0].id);
  assert.equal(approvals[2].digest, approvals[0].digest); assert.notEqual(approvals[1].digest, approvals[0].digest); assert.equal(new Set(approvals.map(value => value.id)).size, 3);
  native = await failureObserver(host, active); storage = await failureObserver(host, active, 'storage'); evidence.downtimeReaders = [native.inspect, storage.inspect];
  phase = 'full-slot-downtime'; evidence.downtime = {}; await selectedDowntime({ host, active, clock, native, storage, access, evidence: evidence.downtime }); await save('downtime.json', evidence.downtime);
  await native.close(); native = null; await storage.close(); storage = null;
  phase = 'failed-work-browser'; evidence.browser = {}; await selectedFailureBrowser({ host, fixture, active, clock, evidence: evidence.browser });
  let final = await pausedSnapshot(active); evidence.finalPauseAt = final.confirmedPauseAt; delete final.confirmedPauseAt;
  evidence.untouchedAfter = await nativeObservation(host, imported.slot, imported.id, { captureProofs: true, persistedRecords: true }); assert.deepEqual(evidence.untouchedAfter.databases, evidence.untouchedBefore.databases);
  assert.deepEqual(verifiedObservationKeys(host.policy, imported.slot, evidence.untouchedAfter), verifiedObservationKeys(host.policy, imported.slot, evidence.untouchedBefore));
  evidence.finalProcesses = await nativeProcesses(host); assert.deepEqual(evidence.finalProcesses, host.nativeBaseline);
  evidence.heldIntervals.push(...evidence.browser.heldIntervals, { start: evidence.beforeSparse.confirmedPauseAt, end: evidence.terminal.phase.held.end, scope: 'Observed preparation across ordinary approval' }, { start: evidence.beforeMinuteAgain.confirmedPauseAt, end: evidence.downtime.phase.held.end, scope: 'Observed preparation across ordinary approval' });
  for (const selected of [evidence.baseline, evidence.noRetry.phase, evidence.noRetry.healthy, evidence.ownerLoss.phase, evidence.terminal.phase, evidence.terminal.healthy, evidence.downtime.phase, evidence.browser.phase, evidence.browser.healthy]) evidence.heldIntervals.push(selected.held);
  for (const [index, selected] of [evidence.baseline, evidence.terminal.phase, evidence.downtime.phase].entries()) evidence.heldIntervals.push({ start: approvals[index].initialPauseAt, end: selected.held.end });
  assert.throws(() => requestedRuntime({ runtime: host.entry.id }), /ordinary enrollment remains closed/);
  for (const build of Object.values(fixture.builds)) assert.throws(() => translateConfig(build.verification.native, 'refresh'), /Unsupported binding\/config: triggers/);
  evidence.statuses = [];
  for (const [index, submitted] of fixture.submissions.refresh.entries()) {
    const status = await host.json(['status', submitted.id], { env: { ...host.env, FOGD_DEPLOY_TOKEN: fixture.tokens.refresh } });
    assert.equal(status.id, submitted.id); assert.equal(status.status, index === 2 ? 'active' : 'superseded'); assert.equal(status.digest, submitted.digest); evidence.statuses.push(status);
  }
  assert.equal(evidence.statuses.length, 3);
  phase = 'final-held-minute';
  evidence.finalHeld = { first: final, start: evidence.finalPauseAt, target: (Math.floor(evidence.finalPauseAt / 60000) + 1) * 60000 + defaults.operationDeadlineMs + 5000 };
  await waitFailureTime(clock, evidence.finalHeld.target);
  const heldAgain = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
  assert.equal(heldAgain.status.paused, true); assert.equal(heldAgain.status.nextAlarm, null); assert.equal(heldAgain.stored.pointer.version, active.version);
  for (const table of ['cron_fault_attempts', 'refresh_occurrences', 'refresh_results']) assert.deepEqual(rows(heldAgain, table), rows(final, table), `${table}: late write after final pause`);
  evidence.finalHeld.end = await clock(); final = heldAgain;
  evidence.heldIntervals.push({ start: evidence.baseline.browserPause.heldAt, end: evidence.noRetry.phase.held.end }, { start: evidence.browser.recoveredPause.heldAt, end: evidence.finalHeld.end });
  evidence.history = assertFailureHistory(evidence, final); assert.ok(!access.events.some(event => event.refused));
  phase = 'shutdown'; const surfaces = await offlineSurfaces(host, fixture);
  await failureDiagnosticReceipt(host, fixture, { scope: 'Selected local Linux arm64 failure profile: ordinary offline artifacts, scoped HTTPS approval, native noRetry, owner loss, sparse counted terminal failure, full-slot downtime and failed-work browser state. Public admission and remaining M11c lifecycle gates stay closed.', provenance, sources, defaults, evidence, final, accesses: access.events }, surfaces);
  console.log('PASS-selected-failure-profile-only');
} catch (error) {
  failure = error;
  try { await save('failure.json', { phase, name: error.name, message: error.message, causes: error.errors?.map(value => ({ name: value.name, message: value.message })), evidence, accesses: access.events }); } catch (recordError) { console.error('Failure record unavailable:', recordError.message); }
  throw error;
} finally {
  clearInterval(heartbeat);
  if (!host.closed) try { await cleanupSelectedHost(host); } catch (error) { throw failure ? new AggregateError([failure, error], 'Failure qualification and cleanup failed') : error; }
}
async function pausedSnapshot(active) {
  const held = await pauseFailureWork(host, active, clock), observed = held.observed;
  assert.equal(observed.stored.pointer.version, active.version); return { ...observed, confirmedPauseAt: held.heldAt };
}
