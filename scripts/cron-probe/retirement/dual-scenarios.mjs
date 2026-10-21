import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { runQualification } from '../recovery/trial.mjs';
import { bootstrap, retainAndDown } from '../recovery/lifecycle.mjs';
import { verifyFinalProvenance, verifyRunner as legacyVerifyRunner } from '../recovery/provenance.mjs';
import { restoredClient as legacyRestoreClient } from '../recovery/client.mjs';
import { assertNoReplay } from '../recovery/oracles.mjs';
import { compareSourceVolumes } from '../recovery/preservation.mjs';
import { snapshot, retirement } from './transitions.mjs';
import { recover } from './recovery.mjs';
import { scheduledReplacement } from './replacement.mjs';
import { appData, selectApps, query, operate, control, healthy, resumeCron, futureCron, submitImport } from './applications.mjs';
import { assertRetained, assertControllerFiles } from './preservation.mjs';
import { assertQueuedSurvivor } from './oracles.mjs';
import { vmNow } from '../vm-time.mjs';
import { expect } from '../../guestbook-browser.mjs';

export async function dualRetirementScenarios({ source, runner, output, identity, config = source.config, probes, evidence, progress,
  verifyRunner = legacyVerifyRunner, retireClient = retirement, restoreClient = legacyRestoreClient,
  expectedControllerCommand = () => ['node', '/var/lib/fogd/qualification/controller.mjs'] }) {
  const points = [];
  const history = tables => ({ attempts: tables.cron_fault_attempts, results: tables.refresh_results, occurrences: tables.refresh_occurrences });
  async function armedTogether(probe, names) {
    let controls;
    await expect.poll(async () => {
      controls = Object.fromEntries(await Promise.all(names.map(async name => [name, await control(probe, name)])));
      const now = await vmNow(probe), values = Object.values(controls);
      return values.every(value => !value.paused && value.nextAlarm - now > 30000) && new Set(values.map(value => value.nextAlarm)).size === 1;
    }, { timeout: 90000, intervals: [250, 500] }).toBe(true);
    assert.equal(controls[names[0]].nextAlarm % 60000, 0);
    return { app: names[0], due: controls[names[0]].nextAlarm, controls };
  }
  async function retireAt(probe, label, name, alarm) {
    await progress(`${label}: stopping and archiving ${name}`);
    const point = await snapshot(probe, join(output, `${label}-snapshot`), label, alarm);
    points.push({ probe, point });
    assert.deepEqual(Object.keys(point.manifest.cronRecovery.apps).sort(), Object.keys(alarm.controls).sort());
    if (name === 'imports') assertQueuedSurvivor(point, name, 'retired-input');
    for (const script of Object.keys(alarm.controls)) {
      const prepared = point.manifest.cronRecovery.apps[script];
      assert.equal(prepared.beforePause.paused, false); assert.equal(prepared.beforePause.nextAlarm, alarm.due);
      assert.ok(prepared.completedAt < alarm.due, 'Every selected cron hold must be confirmed before the shared native deadline');
      assert.equal(prepared.observation.paused, true); assert.equal(prepared.observation.nextAlarm, null);
    }
    const { target, plan } = await retireClient(probe, point, name, join(output, `${label}-retired`), label); probes.push(target);
    await progress(`${label}: native cold hold and separate survivor recovery acknowledgment`);
    const recovered = await recover(target, point, plan);
    evidence.retirements.push({ label, name, alarm, before: point.before, sourceApprovals: point.approvals,
      manifest: point.manifest, sourcePreservation: point.shutdown, plan, recovered });
    return { source: probe, target, point, plan, recovered };
  }
  async function firstRetirement() {
    await bootstrap(source, runner); await verifyRunner(source, runner); await selectApps(source);
    const credential = JSON.parse(await source.command(['admin', 'issue-token', 'retired-queue-scope', 'imports']));
    const defaults = { refresh_settings: await query(source, 'refresh', 'SELECT * FROM refresh_settings ORDER BY id;'),
      cron_fault_control: await query(source, 'refresh', 'SELECT * FROM cron_fault_control ORDER BY id;') };
    await operate(source, 'imports', 'pause'); await submitImport(source, 'imports', 'retired-input', 'retained\nqueue');
    await healthy(source, 'refresh', 'original-before');
    const resumed = await resumeCron(source, 'refresh');
    evidence.initial = { resumed, future: await futureCron(source, 'refresh', 'original-before', resumed) };
    return { ...await retireAt(source, 'a', 'imports', await armedTogether(source, ['refresh'])), credential, defaults };
  }
  async function dualRetirement(first) {
    const probe = first.target;
    await verifyRunner(probe, runner);
    await progress('dual: approving a second cron in fresh capacity with independent required configuration');
    evidence.secondCron = await scheduledReplacement(probe, first.credential, first.plan, first.defaults);
    const running = {};
    for (const [name, phase] of [['refresh', 'dual-original'], ['scheduled-next', 'dual-survivor']]) {
      await healthy(probe, name, phase);
      const resumed = await resumeCron(probe, name);
      running[name] = { resumed, future: await futureCron(probe, name, phase, resumed) };
    }
    evidence.twoLiveCrons = running;
    const both = await appData(probe);
    assertNoReplay(history(first.point.before.refresh), history(both.refresh), running.refresh.resumed.requestedAt - 1);
    evidence.twoLiveData = both;
    await assertRetained(probe, first.recovered.retained); await assertControllerFiles(probe, first.recovered.privateFiles);
    const selected = await armedTogether(probe, ['refresh', 'scheduled-next']);
    const result = await retireAt(probe, 'dual', 'refresh', selected);
    assert.deepEqual(Object.keys(result.point.approvals).sort(), ['refresh', 'scheduled-next']);
    for (const [name, retained] of Object.entries(first.recovered.retained)) assert.deepEqual(result.recovered.retained[name], retained);
    return result;
  }
  async function resumeSurvivor(result) {
    const probe = result.target;
    await progress('survivor: separately resuming future work while retired namespaces remain unused');
    assert.deepEqual(probe.backgroundApps, { 'scheduled-next': 'dispatch' });
    await healthy(probe, 'scheduled-next', 'after-dual');
    const resumed = await resumeCron(probe, 'scheduled-next');
    const future = await futureCron(probe, 'scheduled-next', 'after-dual', resumed), after = await appData(probe);
    assertNoReplay(history(result.point.before['scheduled-next']), history(after['scheduled-next']), resumed.requestedAt - 1);
    await assertRetained(probe, result.recovered.retained); await assertControllerFiles(probe, result.recovered.privateFiles);
    evidence.survivor = { resumed, future, before: result.point.before['scheduled-next'], after: after['scheduled-next'] };
    await retainAndDown(probe, null, 'dual-survivor-complete');
  }
  async function auditBothSources(result, retained) {
    await progress('dual-source: restoring both source crons before retirement and comparing their complete ledgers');
    const target = await restoreClient(result.source, result.point.directory, `${config.name}-dual-audit`, join(output, 'dual-source-audit')); probes.push(target);
    const recovered = await recover(target, result.point);
    for (const [name, baseline] of Object.entries(retained)) assert.deepEqual(recovered.retained[name], baseline);
    assert.deepEqual(recovered.controllerCommand, expectedControllerCommand(target));
    assert.deepEqual(target.backgroundApps, { refresh: 'dispatch', 'scheduled-next': 'dispatch' });
    await verifyRunner(target, runner);
    for (const hold of [recovered.cold, recovered.runningHold]) {
      assert.deepEqual(hold.before.data, result.point.before); assert.deepEqual(hold.after.data, result.point.before);
      assert.deepEqual(Object.keys(hold.before.controls).sort(), ['refresh', 'scheduled-next']);
    }
    evidence.dualSourceAudit = { manifest: result.point.manifest, before: result.point.before, recovered };
    await retainAndDown(target, null, 'dual-source-audit-complete');
  }
  await runQualification(probes, output, async () => {
    await progress('source: creating the initial cron/queue installation');
    const first = await firstRetirement(), result = await dualRetirement(first);
    await resumeSurvivor(result); await auditBothSources(result, first.recovered.retained);
    evidence.shutdowns = probes.map(probe => ({ project: probe.project, ...probe.shutdown }));
  });
  evidence.finalSourcePreservation = [];
  for (const { probe, point } of points) evidence.finalSourcePreservation.push({ project: probe.project, ...await compareSourceVolumes(probe, point.directory) });
  await verifyFinalProvenance(identity); evidence.provenance = identity;
  await writeFile(join(output, 'dual-retirement.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await progress('complete: dual-cron retirement and source audit stopped; every volume retained');
  return { points, evidence };
}
