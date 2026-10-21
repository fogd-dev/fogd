import { runQualification } from './cron-probe/recovery/trial.mjs';
import { assertNoReplay, skippedDue } from './cron-probe/recovery/oracles.mjs';
import { provenance, verifyFinalProvenance, verifyRunner } from './cron-probe/recovery/provenance.mjs';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { prepareRecoveryFixture } from './cron-probe/recovery/fixture.mjs';
import { recoveryClient, restoredClient } from './cron-probe/recovery/client.mjs';
import { bootstrap, snapshot, retainAndDown, armDueTimer } from './cron-probe/recovery/lifecycle.mjs';
import { policy, operation, importJob, completedImport, freshResult, pendingRetry, data, resumeScheduled } from './cron-probe/recovery/data.mjs';
import { coldRestore, startRecovery, acknowledge } from './cron-probe/recovery/restore.mjs';
import { vmNow } from './cron-probe/vm-time.mjs';

const [template, outputArg, image] = process.argv.slice(2);
assert.ok(template && outputArg && image, 'Usage: node scripts/cron-recovery.mjs TEMPLATE_COMPOSE NEW_PRIVATE_OUTPUT RUNTIME_IMAGE');
const output = resolve(outputArg), probes = [], evidence = {};
const identity = await provenance(image);
const { config, runner } = await prepareRecoveryFixture(resolve(template), output, image, identity.image);
const selected = JSON.parse(await readFile(join(output, 'environment.json'), 'utf8'));
const source = await recoveryClient(output, config, selected); probes.push(source); source.identity = identity;
const progress = async step => {
  console.log(step);
  await writeFile(join(output, 'progress.json'), JSON.stringify({ step, project: probes.at(-1).project }) + '\n', { mode: 0o600 });
};
async function restoreProfile(point, suffix) {
  const probe = await restoredClient(source, point.directory, `${config.name}-${suffix}`, join(output, suffix)); probes.push(probe);
  await progress(`${suffix}: native replicas only; controller stays stopped`);
  const cold = await coldRestore(probe, point.before, point.prepared, point.approvals);
  await progress(`${suffix}: opening recovery controller after the quiet interval`);
  const pending = await startRecovery(probe, point), acknowledged = await acknowledge(probe, pending, point);
  evidence[suffix] = { cold, pending, acknowledged };
  return probe;
}
async function firstSnapshot() {
  await bootstrap(source, runner); await verifyRunner(source, runner); await progress('source: normal queued app and private cron approval ready');
  await importJob(source, 'before-a', 'apple\npear');
  assert.deepEqual((await completedImport(source, 'before-a')).results.map(row => row.label), ['APPLE', 'PEAR']);
  await policy(source, 'healthy', 'snapshot-a'); evidence.initialResume = await resumeScheduled(source);
  const armed = await armDueTimer(source);
  await progress('source: armed future timer; taking the complete A snapshot');
  return snapshot(source, join(output, 'snapshot-a'), armed.nextAlarm, 'a');
}
async function secondSnapshot(probe, point) {
  await operation(probe, 'imports', 'resume');
  await importJob(probe, 'after-a', 'melon\nplum'); const imported = await completedImport(probe, 'after-a');
  assert.deepEqual(imported.results.map(row => row.label), ['MELON', 'PLUM']);
  await policy(probe, 'healthy', 'after-a'); const resumed = await resumeScheduled(probe);
  const completed = await freshResult(probe, 'after-a');
  const dueFate = skippedDue(point.before, await data(probe), point.prepared.beforePause.nextAlarm, resumed.requestedAt);
  evidence.afterA = { completed, imported, dueFate, resumed, observedAt: await vmNow(probe) };
  await operation(probe, 'refresh', 'pause'); await policy(probe, 'terminal', 'retry-b');
  await operation(probe, 'imports', 'pause'); await importJob(probe, 'pending-b', 'kiwi\nlime');
  const retryResume = await resumeScheduled(probe);
  await progress('a: waiting for a persisted native retry while queue input stays retained');
  const retry = await pendingRetry(probe);
  assert.ok(retry.allRows.every(row => row.scheduled_time >= retryResume.requestedAt));
  evidence.pendingRetry = { ...retry, resumed: retryResume };
  await progress('a: persisted retry armed; taking the complete B snapshot');
  return snapshot(probe, join(output, 'snapshot-b'), retry.retry.due_ms, 'b');
}
async function resumedB(probe) {
  await operation(probe, 'imports', 'resume'); const imported = await completedImport(probe, 'pending-b');
  assert.deepEqual(imported.results.map(row => row.label), ['KIWI', 'LIME']);
  await policy(probe, 'healthy', 'after-b'); const resumed = await resumeScheduled(probe);
  const future = await freshResult(probe, 'after-b'), after = await data(probe);
  assertNoReplay(evidence.b.cold.before, after, resumed.requestedAt - 1);
  assert.ok(future.every(row => row.scheduled_time >= resumed.requestedAt));
  evidence.afterB = { future, imported, resumed, observedAt: await vmNow(probe) };
  await retainAndDown(probe, null, 'b-complete');
}
async function olderA(point) {
  const probe = await restoreProfile(point, 'older-a'), recovered = await data(probe);
  assert.ok(!recovered.imports.some(row => ['after-a', 'pending-b'].includes(row.id)), 'Older physical snapshot must expose the measured loss of later acknowledged inputs/results');
  assert.ok(evidence.afterA.completed.every(row => !recovered.attempts.some(old => old.id === row.id)));
  for (const app of ['refresh', 'imports']) assert.notEqual(evidence.a.pending[app].recovery.id, evidence['older-a'].pending[app].recovery.id);
  assert.ok(evidence.afterB.future.every(row => !recovered.attempts.some(old => old.id === row.id)));
  assert.match(evidence['older-a'].pending.refresh.recovery.notice, /lose acknowledged results or replay external effects/);
  await policy(probe, 'healthy', 'older-a'); const resumed = await resumeScheduled(probe);
  const future = await freshResult(probe, 'older-a');
  const dueFate = skippedDue(point.before, await data(probe), point.prepared.beforePause.nextAlarm, resumed.requestedAt);
  evidence.olderLoss = { olderCase: 'due-timer snapshot A, before pending-retry snapshot B', dueFate, resumed, lostImports: ['after-a', 'pending-b'], lostNativeAttemptIds: evidence.afterA.completed.map(row => row.id), resumedFuture: future, notice: evidence['older-a'].pending.refresh.recovery.notice };
  await retainAndDown(probe, null, 'older-a-complete');
}
await runQualification(probes, output, async () => {
  await progress('source: creating fresh private installation');
  const a = await firstSnapshot();
  const targetA = await restoreProfile(a, 'a');
  const b = await secondSnapshot(targetA, a);
  const targetB = await restoreProfile(b, 'b'); await resumedB(targetB);
  await olderA(a);
  evidence.snapshots = { a: a.manifest, b: b.manifest };
  evidence.sourcePreservation = { a: a.shutdown, b: b.shutdown };
  evidence.shutdowns = probes.map(probe => ({ project: probe.project, ...probe.shutdown }));
});
await verifyFinalProvenance(identity); evidence.provenance = identity;
await writeFile(join(output, 'recovery.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await progress('complete: all qualification projects stopped; volumes retained');
console.log('PASS: native full-installation cron/queue holds before controller startup, explicit recovery acknowledgment, separate resume, due timer, cleared pending retry and older-snapshot loss boundary');
