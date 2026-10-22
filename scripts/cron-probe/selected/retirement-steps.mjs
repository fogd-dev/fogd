import assert from 'node:assert/strict';
import { join } from 'node:path';
import { backgroundSnapshot, preserveSource } from './recovery-snapshot.mjs';
import { retirementTarget } from './retirement-target.mjs';
import { heldRetirement } from './retirement-holds.mjs';
import { nativeObservation } from './observations.mjs';
import { verifiedObservationKeys } from './failure-authority.mjs';
import { prefixFingerprints } from '../../queue-probe/prefix-fingerprints.mjs';
import { assertControllerFiles } from '../retirement/preservation.mjs';
import { importJob } from './background-fixtures.mjs';
import { rows } from './recovery-ledger.mjs';
import { waitFor } from './https.mjs';

export async function retainedHistory(host, expected, privateFiles, running = true) {
  const actual = {};
  for (const [name, value] of Object.entries(expected)) {
    actual[name] = { prefix: value.prefix, objects: await prefixFingerprints(host.compose, value.prefix, running) };
    assert.deepEqual(actual[name], value);
  }
  await assertControllerFiles({ identity: { image: host.entry.image }, config: host.config }, privateFiles);
  return actual;
}

export async function fleetProofs(host, empty = false) {
  const observations = [], keys = {};
  for (const fleet of host.policy.fleets) {
    const observed = await nativeObservation(host, fleet.id, undefined, { captureProofs: true });
    keys[fleet.id] = verifiedObservationKeys(host.policy, fleet.id, observed);
    if (empty) { assert.equal(observed.count, 0); assert.equal(observed.truncated, false); assert.deepEqual(observed.keys, []); }
    observations.push(observed);
  }
  return { observations, keys };
}

export async function retireStep(context, host, approvals, name, surface, label, alarms, previous, sourceProofs) {
  const { source, installations, evidence } = context;
  context.phase = `${label}-snapshot`;
  const proofs = sourceProofs || await fleetProofs(host);
  const point = await backgroundSnapshot(host, approvals, join(source.output, `${label}-snapshot`), alarms, installations);
  context.phase = `${label}-retirement`;
  const target = await retirementTarget(host, point, approvals[name], surface, join(source.output, `${label}-retired`), installations); installations.push(target);
  const record = { label, point, proofs, project: target.project, policy: target.policy, plan: target.retirement, refusals: target.refusals, initialServices: target.initialServices };
  evidence.chain ||= []; evidence.chain.push(record);
  context.phase = `${label}-held-recovery`; const held = await heldRetirement(target, point, installations); record.held = held.evidence;
  for (const [name, value] of Object.entries(previous.retainedAfter)) assert.deepEqual(record.held.retainedBefore[name], value);
  await assertControllerFiles({ identity: { image: target.entry.image }, config: target.config }, previous.privateFilesAfter);
  return { host, point, target, held, record };
}

export async function queuedInput(host, request, active, id, text, labels) {
  await host.command(['admin', 'delivery', active.app, 'pause']); await importJob(request, id, text, active.app);
  const pending = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
  assert.equal(rows(pending, 'import_jobs').find(row => row.id === id).status, 'accepted');
  assert.equal(pending.queuePeek.messages.length, 1); assert.equal(pending.queuePeek.messages[0].attempts, 0);
  return { pending, labels, id };
}

export async function completeQueuedInput(host, active, pending) {
  await host.command(['admin', 'delivery', active.app, 'resume', active.id, active.digest]);
  const observed = await waitFor('surviving queued input completes', async () => {
    const value = await nativeObservation(host, active.slot, active.id, { persistedRecords: true });
    return rows(value, 'import_jobs').some(row => row.id === pending.id && row.status === 'complete') && value.queuePeek.messages.length === 0 && value;
  });
  assert.deepEqual(rows(observed, 'import_results').filter(row => row.job_id === pending.id).map(row => row.label), pending.labels);
  return observed;
}

export async function preserveSnapshots(snapshots) {
  const results = [];
  for (const { host, point } of snapshots) results.push({ project: host.project, bundle: point.bundle, compared: await preserveSource(host, point) });
  return results;
}
