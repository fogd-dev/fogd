import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { selectedHost, cleanupSelectedHost } from './host.mjs';
import { httpsClient, waitFor, crossMinute } from './https.mjs';
import { controllerState, nativeObservation } from './observations.mjs';
import { sourceInventory, sourceState, expectRefusal, assertActive } from './evidence.mjs';
import { scanPublicSurfaces } from './privacy.mjs';
import { deployFixture } from './fixture.mjs';
import { interruptApproval } from './interruption.mjs';
import { futureJobs, occurrenceKeys, ledgerRows } from './future-jobs.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/cron-probe/selected/activation-matrix.mjs PRIVATE_OUTPUT_DIRECTORY');
const provenance = await sourceState(), sources = await sourceInventory(), host = await selectedHost(process.argv[2]), cases = [], submissions = [];
const save = (name, value) => writeFile(join(host.output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
let phase = 'baseline';
const heartbeat = setInterval(() => console.log(`waiting: ${phase}`), 20000); heartbeat.unref();
try {
  const request = await httpsClient(host);
  await waitFor('HTTPS admin', async () => (await request('/v1/admin')).status === 200);
  await waitFor('signed native fleets', async () => {
    for (const fleet of host.policy.fleets) await nativeObservation(host, fleet.id);
    return true;
  });
  const token = (await host.json(['admin', 'issue-token', 'activation-matrix-builder', 'refresh'])).token;
  const secretValue = randomBytes(32).toString('hex');
  const revision = (await host.json(['admin', 'secrets', 'refresh'], { inputText: JSON.stringify({ REFRESH_TOKEN: secretValue }) })).revision;
  const baseline = await deployFixture(host, token, 'baseline-v1');
  submissions.push(baseline);
  await host.command(['admin', 'approve', baseline.id, baseline.digest, revision]);
  const baselineApprovedAt = Date.now(), baselineJobs = await futureJobs(host, baseline, baselineApprovedAt);
  assertActive(await controllerState(host), baseline, revision);
  console.log('baseline-future-native-jobs');
  for (const specification of [{ label: 'resume-cut-v2', cut: 'resume', desired: 'running' }, { label: 'release-cut-v3', cut: 'release', desired: 'running' }, { label: 'paused-update-v4', cut: 'release', desired: 'paused' }]) {
    phase = specification.label;
    if (specification.desired === 'paused') {
      const paused = await host.json(['admin', 'dispatch', 'refresh', 'pause']);
      assert.equal(paused.desired, 'paused'); assert.equal(paused.observed, 'paused');
    }
    const submitted = await deployFixture(host, token, specification.label);
    submissions.push(submitted);
    const before = await controllerState(host), slot = before.apps.refresh.slot;
    const ledgerBefore = await nativeObservation(host, slot, submitted.id);
    const interrupted = await interruptApproval(host, submitted, revision, specification.cut, specification.desired);
    const reheldBefore = interrupted.reheld, oldKeys = occurrenceKeys(ledgerBefore);
    const newKeys = occurrenceKeys(reheldBefore).filter(key => !oldKeys.includes(key));
    const reholdConfirmedAt = Date.parse(interrupted.recovered.apps.refresh.dispatch.observedAt);
    assert.ok(Number.isFinite(reholdConfirmedAt));
    const reheldRows = reheldBefore.databases.flatMap(database => database.data.refresh_occurrences || []);
    assert.ok(reheldRows.every(row => row.last_attempt_at <= reholdConfirmedAt));
    if (specification.desired === 'paused') assert.deepEqual(ledgerRows(reheldBefore), ledgerRows(ledgerBefore));
    const forbidden = await deployFixture(host, token, `alternative-${specification.label}`);
    submissions.push(forbidden);
    const afterAlternativeBuild = await nativeObservation(host, slot, submitted.id);
    assert.deepEqual(ledgerRows(afterAlternativeBuild), ledgerRows(reheldBefore));
    assert.equal(reheldBefore.status.paused, true); assert.equal(reheldBefore.status.nextAlarm, null);
    const heldBoundary = await crossMinute(), reheldAfter = await nativeObservation(host, slot, submitted.id);
    assert.equal(reheldAfter.status.paused, true); assert.equal(reheldAfter.status.nextAlarm, null);
    assert.deepEqual(ledgerRows(reheldAfter), ledgerRows(reheldBefore));
    const stateBeforeRefusal = await controllerState(host);
    const refusal = await expectRefusal(host, ['admin', 'approve', forbidden.id, forbidden.digest, revision], /Retry the held cron activation before changing its approval/);
    assert.deepEqual(await controllerState(host), stateBeforeRefusal);
    const afterRefusal = await nativeObservation(host, slot, submitted.id);
    assert.deepEqual(ledgerRows(afterRefusal), ledgerRows(reheldBefore));
    assert.equal(afterRefusal.stored.manifest.version, interrupted.native.stored.manifest.version);
    const retryRequestedAt = Date.now(); await host.command(['admin', 'approve', submitted.id, submitted.digest, revision]); const retryReturnedAt = Date.now();
    const active = await controllerState(host); assertActive(active, submitted, revision, specification.desired);
    let future, pausedBoundary, explicitResumeReturnedAt;
    if (specification.desired === 'paused') {
      const beforePausedMinute = await nativeObservation(host, slot, submitted.id); assert.equal(beforePausedMinute.status.paused, true);
      assert.deepEqual(ledgerRows(beforePausedMinute), ledgerRows(afterRefusal));
      pausedBoundary = await crossMinute();
      const afterPausedMinute = await nativeObservation(host, slot, submitted.id); assert.equal(afterPausedMinute.status.paused, true);
      assert.deepEqual(ledgerRows(afterPausedMinute), ledgerRows(beforePausedMinute));
      pausedBoundary = { boundary: pausedBoundary, before: beforePausedMinute, after: afterPausedMinute };
      const resumed = await host.json(['admin', 'dispatch', 'refresh', 'resume', submitted.id, submitted.digest]); assert.equal(resumed.observed, 'running');
      explicitResumeReturnedAt = Date.now(); future = await futureJobs(host, submitted, explicitResumeReturnedAt);
    } else future = await futureJobs(host, submitted, retryReturnedAt);
    const firstAppReadAt = Date.now(), app = await request('/api/refresh', { app: 'refresh' });
    assert.equal(app.status, 200); assert.equal(app.json().release, submitted.label);
    assert.ok(future.databases.flatMap(database => database.data.refresh_results || []).every(row => !row.value.startsWith('alternative-')));
    const result = { ...specification, submitted, forbidden, before, ledgerBefore, interrupted, reholdConfirmedAt, reheldBefore, afterAlternativeBuild, heldBoundary, reheldAfter, afterRefusal, refusal, active,
      authorizedOccurrenceKeysBeforeRehold: newKeys, retryRequestedAt, retryReturnedAt, pausedBoundary, explicitResumeReturnedAt, future, firstAppReadAt, app: app.json() };
    await save(`${specification.label}-result.json`, result); cases.push(result); console.log(`PASS-${specification.label}`);
  }
  phase = 'final-identities'; const identities = [];
  for (const fleet of host.policy.fleets) identities.push(await nativeObservation(host, fleet.id, undefined, { captureProofs: true }));
  const receipt = { scope: 'Selected frozen-image native resume, durable release and paused update interruptions through ordinary HTTPS CLI', project: host.project, family: host.entry.id, image: host.entry.image,
    policy: host.policy, provenance, sources, baseline, baselineApprovedAt, baselineJobs, cases, identities };
  receipt.privacy = await scanPublicSurfaces(host, request, submissions, token, [secretValue], receipt);
  assert.deepEqual(await sourceInventory(), sources); assert.deepEqual(await sourceState(), provenance);
  await save('result.json', receipt);
  console.log('PASS-selected-activation-matrix');
} catch (error) {
  await save('failure.json', { phase, name: error.name, message: error.message }); throw error;
} finally { clearInterval(heartbeat); await cleanupSelectedHost(host); }
