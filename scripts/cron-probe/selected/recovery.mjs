import assert from 'node:assert/strict';
import { writeFile, mkdir, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { selectedHost, cleanupSelectedHost } from './host.mjs';
import { recoveryFixtures, importJob, recoveredData } from './recovery-fixtures.mjs';
import { normalSnapshot, preserveSource, verifyRecoveryBundle } from './recovery-snapshot.mjs';
import { recoveryTarget } from './recovery-target.mjs';
import { coldRecovery, acknowledgeRecovery } from './recovery-holds.mjs';
import { stopSelectedHost } from './shutdown.mjs';
import { armedTimer, pendingRetry, resumeCron, observeNoReplay } from './recovery-work.mjs';
import { setFaultPolicy, nativeObservation, vmTime } from './observations.mjs';
import { sourceInventory, sourceState } from './evidence.mjs';
import { httpsClient, waitFor } from './https.mjs';
import { scanPublicSurfaces, scanOutputFiles } from './privacy.mjs';
import { selectedHostOptions } from './options.mjs';
import { fileURLToPath } from 'node:url';
import { rows, assertRetainedInput } from './recovery-ledger.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { recordRequests, retainedInstallations } from './recovery-evidence.mjs';

const options = selectedHostOptions(process.argv.slice(2));
const provenance = await sourceState(), sources = await sourceInventory(), source = await selectedHost(options.output, options.enrollment, undefined, options.hostOptions);
const installations = [source], evidence = {}, journal = [];
let phase = 'source-fixtures', failure;
const save = (name, value) => writeFile(join(source.output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  await save('executed-source-inventory.json', { provenance, sources });
  for (const path of Object.keys(sources)) {
    const target = join(source.output, 'executed-source', path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await cp(join(repo, path), target);
  }
  const fixture = await recoveryFixtures(source, recordRequests(source, await httpsClient(source), journal));
  await importJob(fixture.request, 'before-a', 'apple\npear');
  await completeImport(source, fixture, 'before-a', ['APPLE', 'PEAR']);
  evidence.sourceIdentities = await identities(source);
  await resumeCron(source, fixture.approvals.refresh);
  const armed = await armedTimer(source, fixture.approvals.refresh);
  phase = 'snapshot-a'; const a = await normalSnapshot(source, fixture, join(source.output, 'snapshot-a'), armed.status.nextAlarm, installations);
  evidence.snapshotA = a; await save('snapshot-a-evidence.json', a);
  const targetA = await restoreProfile(source, a, 'a'), requestA = targetA.request;
  await targetA.command(['admin', 'delivery', 'imports', 'resume', fixture.approvals.imports.id, fixture.approvals.imports.digest]);
  await importJob(requestA, 'after-a', 'melon\nplum'); await completeImport(targetA, fixture, 'after-a', ['MELON', 'PLUM']);
  await setFaultPolicy(targetA, fixture.approvals.refresh.slot, fixture.approvals.refresh.id, 'healthy', 'after-a');
  const afterAResume = await resumeCron(targetA, fixture.approvals.refresh); phase = 'future-after-a';
  evidence.afterA = { resumed: afterAResume, work: await observeNoReplay(targetA, fixture.approvals.refresh, a, afterAResume.requestedAt, 'after-a') };
  assert.ok(afterAResume.requestedAt > a.prepared.beforePause.nextAlarm);
  evidence.afterA.firstAppReadAt = await vmTime(targetA); assert.equal((await requestA('/api/refresh', { app: 'refresh' })).status, 200);
  evidence.a.identities = await identities(targetA);
  assert.equal((await targetA.json(['admin', 'dispatch', 'refresh', 'pause'])).observed, 'paused');
  assert.equal((await targetA.json(['admin', 'delivery', 'imports', 'pause'])).observed, 'paused');
  await importJob(requestA, 'pending-b', 'kiwi\nlime');
  const pendingInput = await recoveredData(targetA, fixture.approvals), pendingJob = rows(pendingInput.imports, 'import_jobs').find(row => row.id === 'pending-b');
  assert.equal(pendingJob.status, 'accepted'); assert.equal(pendingJob.attempts, 0);
  assert.equal(pendingInput.imports.queuePeek.messages.length, 1); assert.equal(pendingInput.imports.queuePeek.messages[0].attempts, 0);
  assert.deepEqual(JSON.parse(Buffer.from(pendingInput.imports.queuePeek.messages[0].bodyBase64, 'base64').toString('utf8')), { id: 'pending-b' });
  await setFaultPolicy(targetA, fixture.approvals.refresh.slot, fixture.approvals.refresh.id, 'terminal', 'retry-b');
  const retryResume = await resumeCron(targetA, fixture.approvals.refresh); phase = 'pending-native-retry';
  const retry = await pendingRetry(targetA, fixture.approvals.refresh, retryResume.requestedAt);
  assert.ok(retry.scheduledTime > retryResume.requestedAt);
  assert.ok(rows(retry.observed, 'cron_fault_attempts').filter(row => row.phase === 'retry-b').every(row => row.scheduled_time >= retryResume.requestedAt));
  evidence.pendingRetry = { ...retry, resumed: retryResume, pendingInput };
  phase = 'snapshot-b'; const b = await normalSnapshot(targetA, fixture, join(source.output, 'snapshot-b'), retry.wake.due_ms, installations);
  assertRetainedInput(b, pendingInput.imports);
  evidence.snapshotB = b; await save('snapshot-b-evidence.json', b);
  const bRequestStart = journal.length;
  const targetB = await restoreProfile(targetA, b, 'b'), requestB = targetB.request;
  await targetB.command(['admin', 'delivery', 'imports', 'resume', fixture.approvals.imports.id, fixture.approvals.imports.digest]);
  await completeImport(targetB, fixture, 'pending-b', ['KIWI', 'LIME']);
  const consumed = await recoveredData(targetB, fixture.approvals), completed = rows(consumed.imports, 'import_jobs').find(row => row.id === 'pending-b');
  assert.equal(completed.status, 'complete');
  assert.deepEqual(rows(consumed.imports, 'import_results').filter(row => row.job_id === 'pending-b').map(row => row.label), ['KIWI', 'LIME']);
  assert.equal(completed.input_hash, pendingJob.input_hash); assert.equal(completed.created_at, pendingJob.created_at); assert.deepEqual(consumed.imports.queuePeek.messages, []);
  await setFaultPolicy(targetB, fixture.approvals.refresh.slot, fixture.approvals.refresh.id, 'healthy', 'after-b');
  const afterBResume = await resumeCron(targetB, fixture.approvals.refresh); phase = 'future-after-b';
  evidence.afterB = { resumed: afterBResume, work: await observeNoReplay(targetB, fixture.approvals.refresh, b, afterBResume.requestedAt, 'after-b'), pendingInputCompletedWithoutPost: true, consumed };
  assert.equal(journal.slice(bRequestStart).filter(entry => entry.method === 'POST').length, 0);
  evidence.afterB.firstAppReadAt = await vmTime(targetB); assert.equal((await requestB('/api/refresh', { app: 'refresh' })).status, 200);
  evidence.b.identities = await identities(targetB); evidence.b.shutdown = await stopSelectedHost(targetB); targetB.closed = true;
  evidence.afterB.applicationRequestWindow = journal.slice(bRequestStart);
  assert.ok(evidence.afterB.applicationRequestWindow.every(entry => entry.method !== 'POST'));
  const older = await restoreProfile(source, a, 'older-a'), olderRequest = older.request;
  const restoredOld = await recoveredData(older, fixture.approvals);
  assert.ok(rows(restoredOld.imports, 'import_jobs').every(row => !['after-a', 'pending-b'].includes(row.id)));
  const laterAttempts = [...rows(evidence.afterA.work.after, 'cron_fault_attempts').filter(row => row.phase === 'after-a'), ...rows(evidence.afterB.work.after, 'cron_fault_attempts').filter(row => row.phase === 'after-b')];
  assert.ok(laterAttempts.length >= 4);
  assert.ok(laterAttempts.every(row => !rows(restoredOld.refresh, 'cron_fault_attempts').some(old => old.id === row.id)));
  for (const app of ['refresh', 'imports']) {
    const ids = ['a', 'b', 'older-a'].map(label => evidence[label].acknowledged.pending[app].recovery.id);
    assert.equal(new Set(ids).size, 3);
  }
  assert.match(evidence['older-a'].acknowledged.pending.refresh.recovery.notice, /lose acknowledged results or replay external effects/);
  await setFaultPolicy(older, fixture.approvals.refresh.slot, fixture.approvals.refresh.id, 'healthy', 'older-a');
  const olderResume = await resumeCron(older, fixture.approvals.refresh); phase = 'future-older-a';
  evidence.olderLoss = { lostImports: ['after-a', 'pending-b'], lostAttemptIDs: laterAttempts.map(row => row.id), resumed: olderResume, work: await observeNoReplay(older, fixture.approvals.refresh, a, olderResume.requestedAt, 'older-a') };
  evidence.olderLoss.firstAppReadAt = await vmTime(older); assert.equal((await olderRequest('/api/refresh', { app: 'refresh' })).status, 200);
  evidence['older-a'].identities = await identities(older);
  phase = 'privacy-and-final-state';
  const receipt = { scope: 'Selected candidate due, retry and older stopped recovery through normal HTTPS workflows; full M11c remains open', provenance, sources, family: source.entry.id, image: source.entry.image, approvals: fixture.approvals, journal, evidence };
  receipt.privacy = [];
  for (const app of ['refresh', 'imports']) receipt.privacy.push(await scanPublicSurfaces(older, olderRequest, [fixture.approvals[app]], fixture.tokens[app], [fixture.secret], receipt));
  evidence['older-a'].shutdown = await stopSelectedHost(older); older.closed = true;
  evidence.sourcePreservation = { a: await preserveSource(source, a), b: await preserveSource(targetA, b) };
  evidence.retainedVolumes = await retainedInstallations(installations);
  receipt.finalPrivacy = await scanOutputFiles(installations, fixture, receipt);
  assert.deepEqual(await sourceInventory(), sources); assert.deepEqual(await sourceState(), provenance);
  await save('result.json', receipt); console.log('PASS-selected-recovery-full');
} catch (error) {
  failure = error;
  await save('failure.json', { phase, name: error.name, message: error.message, evidence }); throw error;
} finally {
  clearInterval(heartbeat);
  const cleanupErrors = [];
  for (const host of installations.filter(host => !host.closed).reverse()) {
    try { await cleanupSelectedHost(host); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], 'Selected recovery cleanup failed; retained volumes were preserved');
}

async function restoreProfile(parent, point, label) {
  assert.deepEqual((await verifyRecoveryBundle(parent, point.bundle)).manifest, point.manifest, 'Snapshot changed before reuse');
  phase = `${label}-restore`; const target = await recoveryTarget(parent, point.bundle, join(source.output, label), installations, point.manifest.images); installations.push(target);
  phase = `${label}-cold-hold`; const cold = await coldRecovery(target, point, installations);
  target.request = recordRequests(target, await httpsClient(target), journal);
  phase = `${label}-acknowledged-hold`; const acknowledged = await acknowledgeRecovery(target, point, installations, target.request);
  evidence[label] = { project: target.project, policy: target.policy, refusals: target.refusals, restoreFence: target.restoreFence, networks: target.networks, initialServices: target.initialServices, cold, acknowledged };
  return target;
}
async function completeImport(host, fixture, id, labels) {
  await waitFor('retained import completion', async () => {
    const value = await nativeObservation(host, fixture.approvals.imports.slot, fixture.approvals.imports.id, { persistedRecords: true });
    const row = rows(value, 'import_jobs').find(row => row.id === id);
    if (row?.status !== 'complete') return false;
    assert.deepEqual(rows(value, 'import_results').filter(row => row.job_id === id).map(row => row.label), labels);
    return value.status.backlogCount === 0 && value.queuePeek.messages.length === 0;
  });
}
async function identities(host) {
  const processes = await nativeProcesses(host), result = [];
  if (host.nativeBaseline) assert.deepEqual(processes, host.nativeBaseline);
  else host.nativeBaseline = processes;
  for (const fleet of host.policy.fleets) {
    const observed = await nativeObservation(host, fleet.id, undefined, { captureProofs: true });
    result.push({ ...observed, processes: processes.filter(process => fleet.nodes.some(node => node.host === process.host)) });
  }
  assert.deepEqual(await nativeProcesses(host), processes);
  return result;
}
