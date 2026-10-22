import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedHost, cleanupSelectedHost } from './host.mjs';
import { offlineFixtures, approveOffline } from './offline-fixtures.mjs';
import { nativeObservation, vmTime } from './observations.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { beginFailurePhase, firstFailureOccurrence, assertHealthyOccurrence } from './failure-phases.mjs';
import { assertOfflineLedger } from './offline-ledger.mjs';
import { failureDiagnosticReceipt } from './failure-receipt.mjs';
import { sourceInventory, sourceState } from './evidence.mjs';
import { regularFiles, translateConfig } from '../../../packages/runtime/src/artifact.mjs';
import { offlineSourceHashes } from '../offline-project.mjs';
import { requestedRuntime } from '../../../packages/cli/src/runtime/catalog.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/cron-probe/selected/offline-smoke.mjs NEW_PRIVATE_OUTPUT');
const provenance = await sourceState(), sources = await sourceInventory(), host = await selectedHost(process.argv[2]);
const evidence = {}, clock = () => vmTime(host, host.policy.fleets[1].nodes[0].host); let phase = 'offline-builds', failure;
const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  const fixture = await offlineFixtures(host); host.nativeBaseline = await nativeProcesses(host);
  evidence.builds = Object.fromEntries(Object.entries(fixture.builds).map(([name, build]) => [name, build.verification]));
  let final;
  for (const [name, cron] of [['minute', '* * * * *'], ['sparse', '*/3 * * * *']]) {
    phase = `approve-${name}`; const active = await approveOffline(host, fixture, name);
    assert.equal(active.slot, host.policy.fleets[0].id);
    const configured = await fixture.request('/api/refresh', { app: 'refresh', method: 'POST', headers: { Origin: `https://refresh.localhost:${host.gatewayPort}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'healthy' }) });
    assert.equal(configured.status, 200); assert.deepEqual(configured.json(), { mode: 'healthy' });
    phase = `native-${name}`; const selected = await beginFailurePhase(host, active, `offline-${name}`, clock), first = await firstFailureOccurrence(host, active, selected, cron);
    assertHealthyOccurrence(first); assert.equal(first.time % (name === 'sparse' ? 180000 : 60000), 0);
    const paused = await host.json(['admin', 'dispatch', 'refresh', 'pause']); assert.equal(paused.observed, 'paused');
    final = await nativeObservation(host, active.slot, active.id, { persistedRecords: true }); assert.equal(final.status.paused, true); assert.equal(final.status.nextAlarm, null);
    assert.deepEqual(final.stored.manifest.crons, [cron]); assert.equal(final.stored.pointer.version, active.version);
    evidence[name] = { active, selected, first, paused, final };
    assertOfflineLedger(final, selected, cron, name === 'sparse' ? evidence.minute.final : undefined);
  }
  assert.throws(() => requestedRuntime({ runtime: host.entry.id }), /ordinary enrollment remains closed/);
  for (const build of Object.values(fixture.builds)) assert.throws(() => translateConfig(build.verification.native, 'refresh'), /Unsupported binding\/config: triggers/);
  assert.equal(fixture.submissions.refresh.length, 2); evidence.statuses = [];
  for (const [index, submitted] of fixture.submissions.refresh.entries()) {
    const status = await host.json(['status', submitted.id], { env: { ...host.env, FOGD_DEPLOY_TOKEN: fixture.tokens.refresh } });
    assert.equal(status.status, index === 0 ? 'superseded' : 'active'); assert.equal(status.digest, submitted.digest); evidence.statuses.push(status);
  }
  const surfaces = [await readFile(join(host.output, 'negotiated-capabilities.json'))];
  for (const build of Object.values(fixture.builds)) {
    for (const path of await regularFiles(build.output)) surfaces.push(await readFile(join(build.output, path)));
  }
  for (const { project } of Object.values(fixture.builds)) {
    for (const path of Object.keys(await offlineSourceHashes(project))) surfaces.push(await readFile(join(project, path)));
  }
  phase = 'shutdown';
  await failureDiagnosticReceipt(host, fixture, { scope: 'Ordinary offline Void/fogd minute and sparse builds with exact scoped upload, paused update and native healthy execution only; full selected failure and replacement acceptance remain open', provenance, sources, evidence, final }, surfaces);
  console.log('PASS-selected-ordinary-offline-smoke-only');
} catch (error) {
  failure = error;
  try { await writeFile(join(host.output, 'failure.json'), JSON.stringify({ phase, name: error.name, message: error.message, causes: error.errors?.map(value => ({ name: value.name, message: value.message })), evidence }, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); } catch (recordError) { console.error('Could not retain failure record:', recordError.message); }
  throw error;
} finally {
  clearInterval(heartbeat);
  if (!host.closed) try { await cleanupSelectedHost(host); } catch (error) { throw failure ? new AggregateError([failure, error], 'Offline qualification and cleanup failed') : error; }
}
