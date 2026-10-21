import { runQualification } from './cron-probe/recovery/trial.mjs';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { prepareRecoveryFixture } from './cron-probe/recovery/fixture.mjs';
import { provenance, verifyFinalProvenance, verifyRunner } from './cron-probe/recovery/provenance.mjs';
import { recoveryClient, installedClient } from './cron-probe/recovery/client.mjs';
import { bootstrap, retainAndDown } from './cron-probe/recovery/lifecycle.mjs';
import { pendingRetry } from './cron-probe/recovery/data.mjs';
import { assertNoReplay } from './cron-probe/recovery/oracles.mjs';
import { snapshot, retirement } from './cron-probe/retirement/transitions.mjs';
import { recover } from './cron-probe/retirement/recovery.mjs';
import { queuedReplacement, scheduledReplacement } from './cron-probe/retirement/replacement.mjs';
import { appData, selectApps, query, operate, control, healthy, resumeCron, futureCron, submitImport, completedImport } from './cron-probe/retirement/applications.mjs';
import { assertRetained, assertControllerFiles } from './cron-probe/retirement/preservation.mjs';
import { assertQueuedSurvivor } from './cron-probe/retirement/oracles.mjs';
import { vmNow } from './cron-probe/vm-time.mjs';
import { expect } from './guestbook-browser.mjs';
import { compareSourceVolumes } from './cron-probe/recovery/preservation.mjs';

const [template, destination, image] = process.argv.slice(2);
assert.ok(template && destination && image, 'Usage: node scripts/cron-retirement.mjs TEMPLATE_COMPOSE NEW_PRIVATE_OUTPUT RUNTIME_IMAGE');
const output = resolve(destination), probes = [], snapshots = [], evidence = { retirements: [] };
const identity = await provenance(image);
const { config, runner } = await prepareRecoveryFixture(resolve(template), output, image, identity.image, 'retirement');
const environment = JSON.parse(await readFile(join(output, 'environment.json'), 'utf8'));
const source = await recoveryClient(output, config, environment); source.identity = identity; probes.push(source);
const progress = async step => { console.log(step); await writeFile(join(output, 'progress.json'), JSON.stringify({ step, project: probes.at(-1).project }) + '\n', { mode: 0o600 }); };
const history = tables => ({ attempts: tables.cron_fault_attempts, results: tables.refresh_results, occurrences: tables.refresh_occurrences });
async function arm(probe, name) {
  let observed;
  await expect.poll(async () => { observed = await control(probe, name); return !observed.paused && observed.nextAlarm - await vmNow(probe) > 25000; }, { timeout: 90000, intervals: [250, 500] }).toBe(true);
  return { app: name, due: observed.nextAlarm };
}
function compareRetained(before, after) {
  for (const [name, value] of Object.entries(before || {})) assert.deepEqual(after[name], value, 'Previously retired source bytes changed across a later archive');
}
async function retireAt(probe, label, name, alarm = null, ordinary = false, previous = null) {
  await progress(`${label}: stopping and archiving ${name}`);
  const point = await snapshot(probe, join(output, `${label}-snapshot`), label, alarm);
  snapshots.push({ probe, directory: point.directory });
  const { target, plan } = await retirement(probe, point, name, join(output, `${label}-retired`), label); probes.push(target);
  await progress(`${label}: observing native cold startup and separate recovery acknowledgment`);
  const recovered = await recover(target, point, plan, ordinary);
  compareRetained(previous?.retained, recovered.retained);
  evidence.retirements.push({ label, name, alarm, manifest: point.manifest, plan, before: point.before, sourceApprovals: point.approvals, sourcePreservation: point.shutdown, recovered });
  return { source: probe, target, point, recovered, plan };
}
async function firstRetirement() {
  await bootstrap(source, runner); await verifyRunner(source, runner);
  await selectApps(source);
  assert.ok(source.approvals.refresh.secretRevision, 'The source cron approval must pin a real secret revision');
  const credentials = {};
  for (const name of ['refresh', 'imports']) credentials[name] = JSON.parse(await source.command(['admin', 'issue-token', `old-${name}`, name]));
  evidence.oldCredentials = Object.fromEntries(Object.entries(credentials).map(([name, value]) => [name, { id: value.id, apps: value.apps }]));
  evidence.freshDefaults = { refresh_settings: await query(source, 'refresh', 'SELECT * FROM refresh_settings ORDER BY id;'), cron_fault_control: await query(source, 'refresh', 'SELECT * FROM cron_fault_control ORDER BY id;') };
  await submitImport(source, 'imports', 'before-a', 'apple\npear');
  await completedImport(source, 'imports', 'before-a', ['APPLE', 'PEAR']);
  await operate(source, 'imports', 'pause'); await submitImport(source, 'imports', 'pending-a', 'old\nqueue');
  await healthy(source, 'refresh', 'before-a');
  const resumed = await resumeCron(source, 'refresh'); evidence.initial = { resumed, future: await futureCron(source, 'refresh', 'before-a', resumed) };
  const result = await retireAt(source, 'a', 'imports', await arm(source, 'refresh'));
  return { ...result, credentials };
}
async function retryRetirement(a) {
  const probe = a.target;
  await healthy(probe, 'refresh', 'after-a');
  const resumed = await resumeCron(probe, 'refresh'), future = await futureCron(probe, 'refresh', 'after-a', resumed);
  assertNoReplay(history(a.point.before.refresh), history((await appData(probe)).refresh), resumed.requestedAt - 1);
  evidence.cronSurvivor = { resumed, future, oldAndMissedTicksUnchanged: true };
  await progress('a: approving the ordinary queued replacement in fresh capacity');
  evidence.queuedReplacement = await queuedReplacement(probe, a.credentials.imports, a.plan);
  await operate(probe, 'replacement', 'resume');
  await submitImport(probe, 'replacement', 'new-queue', 'new\nfleet');
  evidence.queuedReplacement.completed = await completedImport(probe, 'replacement', 'new-queue', ['NEW', 'FLEET']);
  await operate(probe, 'replacement', 'pause'); await submitImport(probe, 'replacement', 'pending-b', 'kiwi\nlime');
  await assertRetained(probe, a.recovered.retained); await assertControllerFiles(probe, a.recovered.privateFiles);
  await operate(probe, 'refresh', 'pause');
  await query(probe, 'refresh', "UPDATE cron_fault_control SET policy='terminal',phase='retry-b' WHERE id=1;");
  const retryResume = await resumeCron(probe, 'refresh'), retry = await pendingRetry(probe);
  assert.ok(retry.allRows.every(row => row.scheduled_time >= retryResume.requestedAt));
  evidence.pendingRetry = { ...retry, resumed: retryResume };
  return retireAt(probe, 'b', 'refresh', { app: 'refresh', due: retry.retry.due_ms }, false, a.recovered);
}
async function dueRetirement(b, credentials) {
  assertQueuedSurvivor(b.point, 'replacement', 'pending-b');
  const probe = b.target;
  await operate(probe, 'replacement', 'resume');
  evidence.pendingQueueSurvivor = await completedImport(probe, 'replacement', 'pending-b', ['KIWI', 'LIME']);
  await progress('b: staging a cron replacement with independent required configuration');
  evidence.scheduledReplacement = await scheduledReplacement(probe, credentials.refresh, b.plan, evidence.freshDefaults);
  await healthy(probe, 'scheduled-next', 'new-cron');
  const resumed = await resumeCron(probe, 'scheduled-next');
  evidence.scheduledReplacement.resumed = resumed;
  evidence.scheduledReplacement.future = await futureCron(probe, 'scheduled-next', 'new-cron', resumed);
  await operate(probe, 'replacement', 'pause'); await submitImport(probe, 'replacement', 'pending-c', 'melon\nplum');
  await assertRetained(probe, b.recovered.retained); await assertControllerFiles(probe, b.recovered.privateFiles);
  return retireAt(probe, 'c', 'scheduled-next', await arm(probe, 'scheduled-next'), true, b.recovered);
}
async function zeroLive(c) {
  assertQueuedSurvivor(c.point, 'replacement', 'pending-c');
  const probe = c.target;
  await operate(probe, 'replacement', 'resume');
  evidence.finalQueueSurvivor = await completedImport(probe, 'replacement', 'pending-c', ['MELON', 'PLUM']);
  await operate(probe, 'replacement', 'pause'); await submitImport(probe, 'replacement', 'pending-d', 'retained\nlast');
  await assertRetained(probe, c.recovered.retained);
  const d = await retireAt(probe, 'd', 'replacement', null, true, c.recovered);
  assert.deepEqual(d.target.backgroundApps, {});
  const zeroState = await selectApps(d.target); assert.ok(zeroState.requirements.includes('fogd-cron-retirement-v1'));
  const point = await snapshot(d.target, join(output, 'zero-live-snapshot'), 'zero-live');
  snapshots.push({ probe: d.target, directory: point.directory });
  assert.equal(point.manifest.cronRecovery, undefined); assert.equal(point.manifest.queueRecovery, undefined);
  const target = await installedClient(d.target, ['restore', point.directory], `${config.name}-zero`, join(output, 'zero-live-restored')); probes.push(target);
  await progress('zero-live: ordinary restore and stock controller startup with retained cron history');
  const recovered = await recover(target, point, null, true);
  compareRetained(d.recovered.retained, recovered.retained);
  const state = await selectApps(target); assert.ok(state.requirements.includes('fogd-cron-retirement-v1'));
  assert.deepEqual(target.backgroundApps, {}); assert.equal(recovered.defaultController, true);
  evidence.zeroLive = { manifest: point.manifest, sourcePreservation: point.shutdown, recovered };
  await retainAndDown(target, null, 'zero-live-complete');
}
async function auditRetrySource(b) {
  const directory = join(output, 'retry-source-audit');
  const target = await installedClient(b.source, ['restore', b.point.directory], `${config.name}-retry-audit`, directory); probes.push(target);
  await progress('retry-source: comparing the stopped archive with its pre-pause handler ledger');
  const recovered = await recover(target, b.point);
  assert.deepEqual(recovered.controllerCommand, ['node', '/var/lib/fogd/qualification/controller.mjs']);
  await verifyRunner(target, runner);
  for (const interval of [recovered.cold, recovered.runningHold]) {
    assert.deepEqual(interval.before.data, b.point.before); assert.deepEqual(interval.after.data, b.point.before);
  }
  await retainAndDown(target, null, 'retry-source-audit');
  evidence.retrySourceAudit = { sourceSnapshot: b.plan.snapshot.sha256,
    originalPauseCompletedAt: b.point.manifest.cronRecovery.apps.refresh.completedAt,
    retryDueAt: b.point.alarm.due, originalSourceStoppedAt: b.point.manifest.stoppedAt,
    archivedLedgerEqualsPrePauseRows: true, recovered, shutdown: target.shutdown,
    sourcePreservation: await compareSourceVolumes(b.source, b.point.directory) };
}
await runQualification(probes, output, async () => {
  await progress('source: building a fresh two-fleet cron and queue installation');
  const a = await firstRetirement(), b = await retryRetirement(a), c = await dueRetirement(b, a.credentials);
  await zeroLive(c);
  await auditRetrySource(b);
  evidence.shutdowns = probes.map(probe => ({ project: probe.project, ...probe.shutdown }));
});
evidence.finalSourcePreservation = [];
for (const { probe, directory } of snapshots) evidence.finalSourcePreservation.push({ project: probe.project, ...await compareSourceVolumes(probe, directory) });
await verifyFinalProvenance(identity); evidence.provenance = identity;
await writeFile(join(output, 'retirement.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await progress('complete: all native retirement projects stopped; all volumes retained');
console.log('PASS: due and retry retirement, surviving cron and queue gates, new namespace/data/secrets/authority, retained source bytes and zero-live ordinary restore');
