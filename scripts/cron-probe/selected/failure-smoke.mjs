import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedHost, cleanupSelectedHost } from './host.mjs';
import { backgroundFixtures } from './background-fixtures.mjs';
import { FailureAccess } from './failure-access.mjs';
import { assertNoRetry } from './failure-outcomes.mjs';
import { retryControlReady, assertRetryControl } from './failure-retry.mjs';
import { beginFailurePhase, firstFailureOccurrence, hasSuccessfulOccurrence, assertHealthyOccurrence } from './failure-phases.mjs';
import { nativeObservation, vmTime } from './observations.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { rows } from './recovery-ledger.mjs';
import { sourceInventory, sourceState } from './evidence.mjs';
import { waitFor } from './https.mjs';
import { failureDiagnosticReceipt } from './failure-receipt.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/cron-probe/selected/failure-smoke.mjs NEW_PRIVATE_OUTPUT');
const provenance = await sourceState(), sources = await sourceInventory(), host = await selectedHost(process.argv[2]);
const clockNode = host.policy.fleets[1].nodes[0].host, access = new FailureAccess(clockNode), clock = () => vmTime(host, clockNode);
access.install(host);
const evidence = {}; let phase = 'fixtures';
const save = (name, value) => writeFile(join(host.output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  const fixture = await backgroundFixtures(host), active = fixture.approvals.refresh;
  assert.equal(active.slot, host.policy.fleets[0].id);
  host.nativeBaseline = await nativeProcesses(host);
  const configured = await fixture.request('/api/refresh', { app: 'refresh', method: 'POST', headers: { Origin: `https://refresh.localhost:${host.gatewayPort}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'healthy' }) });
  assert.equal(configured.status, 200); assert.deepEqual(configured.json(), { mode: 'healthy' });
  phase = 'baseline'; const baseline = await beginFailurePhase(host, active, 'baseline', clock);
  const first = await firstFailureOccurrence(host, active, baseline); assertHealthyOccurrence(first);
  evidence.baseline = { ...baseline, first, firstAppReadAt: await clock() };
  assert.equal((await fixture.request('/api/refresh', { app: 'refresh' })).status, 200);
  phase = 'retry-positive-control'; const control = await beginFailurePhase(host, active, 'retry-control', clock);
  const initialThrow = await firstFailureOccurrence(host, active, control);
  const retried = await waitFor('same native occurrence retried to success without noRetry', async () => {
    const observed = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    const attempts = rows(observed, 'cron_fault_attempts').filter(row => row.phase === 'retry-control' && row.scheduled_time === initialThrow.time);
    return retryControlReady(attempts) && hasSuccessfulOccurrence(observed, initialThrow.time) && { observed, attempts };
  }, 45000);
  assertRetryControl(retried.attempts, initialThrow.time);
  assert.ok(hasSuccessfulOccurrence(retried.observed, initialThrow.time));
  evidence.retryControl = { ...control, first: initialThrow, retried };
  phase = 'no-retry'; const noRetry = await beginFailurePhase(host, active, 'no-retry', clock);
  const failed = await firstFailureOccurrence(host, active, noRetry); assertNoRetry(failed.attempts);
  // Keep dispatch running through the following natural tick. Pausing earlier
  // could hide a broken noRetry() by cancelling its pending retry instead.
  const following = await waitFor('next natural noRetry occurrence without a pause', async () => {
    const observed = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    const attempts = rows(observed, 'cron_fault_attempts').filter(row => row.phase === 'no-retry' && row.scheduled_time === failed.time + 60000);
    return ['inventory', 'advisory'].every(job => attempts.some(row => row.job === job && row.outcome !== 'pending')) && { observed, attempts };
  }, 150000);
  assertNoRetry(following.attempts);
  const original = rows(following.observed, 'cron_fault_attempts').filter(row => row.phase === 'no-retry' && row.scheduled_time === failed.time);
  assert.deepEqual(original, failed.attempts);
  evidence.noRetry = { ...noRetry, first: failed, following };
  phase = 'healthy-after-no-retry'; const healthy = await beginFailurePhase(host, active, 'no-retry-future', clock);
  const recovered = await firstFailureOccurrence(host, active, healthy); assertHealthyOccurrence(recovered);
  assert.deepEqual(rows(recovered.observed, 'cron_fault_attempts').filter(row => row.phase === 'no-retry' && row.scheduled_time === failed.time), failed.attempts);
  evidence.healthy = { ...healthy, first: recovered };
  const finalPause = await host.json(['admin', 'dispatch', 'refresh', 'pause']); assert.equal(finalPause.observed, 'paused');
  evidence.finalPauseAt = Date.parse(finalPause.observedAt);
  const final = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
  assert.equal(final.status.paused, true); assert.equal(final.status.nextAlarm, null);
  const all = rows(final, 'cron_fault_attempts'); assert.ok(all.every(row => !['pending', 'rejected'].includes(row.outcome)));
  assert.ok(all.every(row => row.entered_at < evidence.finalPauseAt));
  for (const interval of [{ start: active.initialPauseAt, end: baseline.held.end }, baseline.held, control.held, noRetry.held, healthy.held]) assert.ok(all.every(row => row.entered_at < interval.start || row.entered_at >= interval.end));
  assert.ok(!access.events.some(event => event.refused));
  phase = 'shutdown';
  await failureDiagnosticReceipt(host, fixture, { scope: 'Diagnostic selected success/retry-positive-control/noRetry smoke only; owner-loss, sparse terminal, downtime, ordinary offline builds and UI failure gates remain unqualified', provenance, sources, evidence, final, accesses: access.events });
  console.log('PASS-selected-failure-smoke-only');
} catch (error) { await save('failure.json', { phase, name: error.name, message: error.message, evidence }); throw error; }
finally { clearInterval(heartbeat); if (!host.closed) await cleanupSelectedHost(host); }
