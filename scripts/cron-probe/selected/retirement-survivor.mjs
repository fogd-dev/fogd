import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { selectedHost, cleanupSelectedHost } from './host.mjs';
import { recoveryFixtures, importJob } from './recovery-fixtures.mjs';
import { nativeObservation, setFaultPolicy } from './observations.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { normalSnapshot, preserveSource } from './recovery-snapshot.mjs';
import { armedTimer, resumeCron, futurePhase } from './recovery-work.mjs';
import { retirementTarget } from './retirement-target.mjs';
import { heldRetirement } from './retirement-holds.mjs';
import { retiredQueueReplacement } from './retirement-replacement.mjs';
import { recoveryTarget } from './recovery-target.mjs';
import { coldRecovery, acknowledgeRecovery } from './recovery-holds.mjs';
import { rows, noReplay } from './recovery-ledger.mjs';
import { sourceInventory, sourceState } from './evidence.mjs';
import { stopSelectedHost } from './shutdown.mjs';
import { scanPublicSurfaces, scanOutputFiles } from './privacy.mjs';
import { prefixFingerprints } from '../../queue-probe/prefix-fingerprints.mjs';
import { assertControllerFiles } from '../retirement/preservation.mjs';
import { waitFor } from './https.mjs';
import { checkedNativeDefaults, verifyNativeTimingEnvironment } from '../sealed/defaults.mjs';
import { verifiedObservationKeys } from './failure-authority.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/cron-probe/selected/retirement-survivor.mjs NEW_PRIVATE_OUTPUT');
const provenance = await sourceState(), sources = await sourceInventory(), source = await selectedHost(process.argv[2]);
const installations = [source], evidence = {};
let phase = 'source-fixtures', failure;
const save = (name, value) => writeFile(join(source.output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  await save('executed-source-inventory.json', { provenance, sources }); await cp(import.meta.filename, join(source.output, 'runner.mjs'));
  for (const path of Object.keys(sources)) {
    const target = join(source.output, 'executed-source', path); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); await cp(path, target);
  }
  evidence.defaults = await checkedNativeDefaults();
  evidence.sourceTiming = await verifyNativeTimingEnvironment({ ...source, slots: source.policy.fleets.map(fleet => ({ nodes: fleet.nodes.map(node => node.host) })) });
  const fixture = await recoveryFixtures(source); source.nativeBaseline = await nativeProcesses(source);
  evidence.sourceIdentities = []; evidence.sourceKeys = {};
  for (const fleet of source.policy.fleets) {
    const observed = await nativeObservation(source, fleet.id, undefined, { captureProofs: true });
    evidence.sourceIdentities.push(observed); evidence.sourceKeys[fleet.id] = verifiedObservationKeys(source.policy, fleet.id, observed);
  }
  await source.command(['admin', 'delivery', 'imports', 'pause']); await importJob(fixture.request, 'retired-input', 'retained\nqueue');
  evidence.pendingInput = await nativeObservation(source, fixture.approvals.imports.slot, fixture.approvals.imports.id, { persistedRecords: true });
  assert.equal(rows(evidence.pendingInput, 'import_jobs').find(row => row.id === 'retired-input').status, 'accepted');
  assert.equal(evidence.pendingInput.queuePeek.messages.length, 1); assert.equal(evidence.pendingInput.queuePeek.messages[0].attempts, 0);
  const originalArtifact = await fixture.request(`/v1/deployments/${fixture.approvals.imports.id}/artifact`); assert.equal(originalArtifact.status, 200);
  evidence.resumed = await resumeCron(source, fixture.approvals.refresh); phase = 'source-healthy';
  evidence.sourceHealthy = await futurePhase(source, fixture.approvals.refresh, 'snapshot-a', evidence.resumed.requestedAt);
  phase = 'source-snapshot'; const armed = await armedTimer(source, fixture.approvals.refresh);
  const point = await normalSnapshot(source, fixture, join(source.output, 'source-snapshot'), armed.status.nextAlarm, installations); evidence.snapshot = point;
  phase = 'retirement-create';
  const target = await retirementTarget(source, point, fixture.approvals.imports, 'delivery', join(source.output, 'retired'), installations); installations.push(target);
  evidence.target = { project: target.project, policy: target.policy, plan: target.retirement, refusals: target.refusals, initialServices: target.initialServices, networks: target.networks };
  phase = 'cold-and-acknowledged-hold'; const held = await heldRetirement(target, point, installations); evidence.held = held.evidence;
  await setFaultPolicy(target, fixture.approvals.refresh.slot, fixture.approvals.refresh.id, 'healthy', 'after-a');
  evidence.survivorResume = await resumeCron(target, fixture.approvals.refresh); phase = 'survivor-future';
  evidence.survivorFuture = await futurePhase(target, fixture.approvals.refresh, 'after-a', evidence.survivorResume.requestedAt);
  noReplay(point.sourceObservation.refresh, evidence.survivorFuture, evidence.survivorResume.requestedAt - 1);
  phase = 'fresh-queue-capacity';
  evidence.replacement = await retiredQueueReplacement(target, fixture, held.request, originalArtifact.json(), evidence.held.warmKeys[target.retirement.previous.slot]);
  const replacement = evidence.replacement.active; await importJob(held.request, 'fresh-input', 'melon\nplum', 'replacement');
  await target.command(['admin', 'delivery', 'replacement', 'resume', replacement.id, replacement.digest]);
  evidence.freshImport = await waitFor('new namespace input completes', async () => {
    const observed = await nativeObservation(target, replacement.slot, replacement.id, { persistedRecords: true, captureProofs: true });
    return rows(observed, 'import_jobs').some(row => row.id === 'fresh-input' && row.status === 'complete') && rows(observed, 'import_results').filter(row => row.job_id === 'fresh-input').length === 2 && observed.queuePeek.messages.length === 0 && observed;
  });
  evidence.freshImportKeys = verifiedObservationKeys(target.policy, replacement.slot, evidence.freshImport);
  assert.deepEqual(evidence.freshImportKeys, evidence.held.warmKeys[replacement.slot]);
  assert.deepEqual(rows(evidence.freshImport, 'import_results').map(row => row.label), ['MELON', 'PLUM']);
  evidence.retainedAfterReuse = await prefixFingerprints(target.compose, target.retirement.previous.prefix, true);
  assert.deepEqual(evidence.retainedAfterReuse, evidence.held.retainedBefore.imports.objects);
  await assertControllerFiles({ identity: { image: target.entry.image }, config: target.config }, evidence.held.privateFilesBefore);
  evidence.privacy = [];
  for (const app of ['refresh', 'imports']) evidence.privacy.push(await scanPublicSurfaces(target, held.request, [fixture.approvals[app]], fixture.tokens[app], [fixture.secret], evidence));
  evidence.privacy.push(await scanPublicSurfaces(target, held.request, [replacement], fixture.tokens.replacement, [fixture.secret], evidence));
  phase = 'target-shutdown'; evidence.targetShutdown = await stopSelectedHost(target); target.closed = true;
  phase = 'original-source-audit';
  const audit = await recoveryTarget(source, point.bundle, join(source.output, 'original-source-audit'), installations, point.manifest.images); installations.push(audit);
  evidence.audit = { project: audit.project, policy: audit.policy, initialServices: audit.initialServices, cold: await coldRecovery(audit, point, installations) };
  evidence.auditTiming = await verifyNativeTimingEnvironment({ ...audit, slots: audit.policy.fleets.map(fleet => ({ nodes: fleet.nodes.map(node => node.host) })) });
  evidence.audit.acknowledged = await acknowledgeRecovery(audit, point, installations);
  evidence.auditShutdown = await stopSelectedHost(audit); audit.closed = true; evidence.sourcePreservation = await preserveSource(source, point);
  const receipt = { scope: 'Selected active-cron survivor retirement and fresh queue capacity diagnostic only. Pending-retry/two-cron/full retirement acceptance and public admission remain open.', provenance, sources, family: source.entry.id, image: source.entry.image, sourcePolicy: source.policy, evidence };
  receipt.finalPrivacy = await scanOutputFiles(installations, fixture, receipt);
  assert.deepEqual(await sourceInventory(), sources); assert.deepEqual(await sourceState(), provenance);
  await save('result.json', receipt);
  const bytes = await readFile(join(source.output, 'result.json')), scan = await scanOutputFiles(installations, fixture, JSON.parse(bytes), [bytes]);
  await save('post-write-privacy.json', { sha256: createHash('sha256').update(bytes).digest('hex'), ...scan });
  console.log('PASS-selected-retirement-survivor-only');
} catch (error) {
  failure = error;
  try { await save('failure.json', { phase, name: error.name, message: error.message, cause: error.cause?.message, evidence }); }
  catch (recordError) { console.error('Could not retain failure record:', recordError.message); }
  throw error;
} finally {
  clearInterval(heartbeat); const errors = [];
  for (const host of installations.filter(host => !host.closed).reverse()) {
    try { await cleanupSelectedHost(host); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError([...(failure ? [failure] : []), ...errors], 'Retirement diagnostic cleanup failed');
}
