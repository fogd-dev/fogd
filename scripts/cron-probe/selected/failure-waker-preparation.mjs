import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { composeArgs } from '../../../packages/cli/src/recovery/docker.mjs';
import { nativeObservation } from './observations.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { rows } from './recovery-ledger.mjs';
import { waitFor } from './https.mjs';
import { selectedFailureNodes, gracefullyStopFailureNode, stoppedFailureNode, restartFailureNode } from './failure-containers.mjs';
import { ownerRoleTrail } from '../faults/recovery-window.mjs';
import { preparationWindow } from './failure-waker-window.mjs';
import { verifyFailureProof } from './failure-authority.mjs';
import { assertPreparedRuntime } from './failure-runtime-state.mjs';
import { nativeLogFailure } from './shutdown.mjs';
import { assertStoppedLease } from './failure-owner.mjs';

export async function prepareOwnerWaker({ host, active, clock, native, storage, defaults, evidence }) {
  const read = () => nativeObservation(host, active.slot, active.id, { captureProofs: true, persistedRecords: true });
  const before = await waitFor('quiescent confirmed pause before waker preparation', async () => {
    const observed = await read(); assert.equal(observed.status.paused, true); assert.equal(observed.status.nextAlarm, null);
    return rows(observed, 'cron_fault_attempts').every(row => row.outcome !== 'pending') && observed;
  }, 30000);
  evidence.before = before;
  const keys = verifiedKeys(host, active, before), initial = await storage.observe('prepare-waker', { keys }); evidence.initial = initial;
  const nodes = await selectedFailureNodes(host, active.slot), owner = initial.bucket.owner.node;
  const keeper = nodes.find(node => node.node === owner), peer = nodes.find(node => node.node !== owner); assert.ok(keeper && peer);
  evidence.owner = owner; evidence.epoch = initial.bucket.owner.epoch; evidence.peer = peer; evidence.keeper = keeper;
  const context = { host, clock, storage, defaults, evidence, keys, owner, peer, initial };
  if (initial.bucket.waker?.node === owner) {
    assert.ok(initial.bucket.waker.expires_ms > initial.bucket.at && initial.bucket.waker.expires_ms <= initial.bucket.at + defaults.wakerLeaseTtlMs);
    evidence.preexistingRole = true;
  }
  else await acquireRole(context);
  evidence.after = await waitFor('complete paused membership after waker preparation', read, 90000);
  assert.equal(evidence.after.status.paused, true); assert.equal(evidence.after.status.nextAlarm, null);
  assert.deepEqual(evidence.after.databases, before.databases);
  evidence.keys = verifiedKeys(host, active, evidence.after);
  for (const node of nodes) {
    if (evidence.restarted && node.node === peer.node) assert.notEqual(evidence.keys[node.node], keys[node.node]);
    else assert.equal(evidence.keys[node.node], keys[node.node]);
  }
  const processes = await nativeProcesses(host);
  for (const prior of host.nativeBaseline) {
    const current = processes.find(row => row.host === prior.host); assert.ok(current); assert.equal(current.container, prior.container);
    if (evidence.restarted && prior.host === peer.host) assert.ok(current.pid !== prior.pid || current.start !== prior.start);
    else assert.deepEqual(current, prior);
  }
  evidence.settle = [];
  for (let index = 0; index < 2; index++) {
    if (index) await delay(defaults.rebalanceTickMs + 100);
    const sample = await native.observe('prepared-state', { keys: evidence.keys }); evidence.settle.push(sample);
    assertPreparedRuntime(sample, owner, evidence.epoch, active.version);
    assert.equal(sample.bucket.waker?.node, owner); assert.ok(sample.bucket.waker.expires_ms > sample.bucket.at);
  }
  assert.ok(evidence.settle[1].bucket.at - evidence.settle[0].bucket.at >= defaults.rebalanceTickMs);
  host.nativeBaseline = processes; host.ownerPreparation = evidence;
  return evidence;
}
function verifiedKeys(host, active, observed) {
  return Object.fromEntries(observed.proofs.values.map(value => {
    const authority = verifyFailureProof(host.policy, active.slot, value.node, value.proof, value.challenge); return [authority.node, authority.publicKey];
  }));
}
async function acquireRole(context) {
  const { host, clock, storage, defaults, evidence, keys, owner, peer } = context;
  evidence.stopped = await gracefullyStopFailureNode(host, peer); evidence.stoppedAt = evidence.stopped.finishedAt;
  evidence.confirmedStoppedAt = await clock(); assert.ok(evidence.stoppedAt <= evidence.confirmedStoppedAt);
  await cleanPeerLogs(host, peer, evidence);
  const postStop = await storage.observe('prepare-waker', { keys, absentId: peer.node }); evidence.postStop = postStop;
  evidence.window = preparationWindow(postStop.bucket, owner, peer.node, evidence.stoppedAt, defaults);
  await waitForOwnerRole(context, postStop);
  evidence.restarted = await restartFailureNode(host, peer, { exit: 0 });
}
async function waitForOwnerRole({ host, clock, storage, evidence, keys, owner, peer, initial, defaults }, postStop) {
  const lease = postStop.bucket.leases.find(row => row.expectedNode === peer.node), peerExpiry = lease.missing ? null : lease.expires_ms;
  evidence.observations = [postStop]; let sample = postStop;
  while (true) {
    assert.deepEqual(sample.bucket.owner, initial.bucket.owner, 'Paused cron owner changed during preparation');
    if (peerExpiry !== null) assertStoppedLease(sample.bucket, peer.node, peerExpiry);
    else assert.ok(sample.bucket.leases.find(row => row.expectedNode === peer.node).missing);
    assert.ok(sample.bucket.at <= evidence.window.deadline, 'Paused waker preparation exceeded its default-election window');
    if (sample.bucket.waker?.node === owner && sample.bucket.waker.expires_ms > sample.bucket.at) {
      if (postStop.bucket.waker?.node === peer.node) evidence.roleTransfer = ownerRoleTrail({ roleHeldByKilledNode: true, roleExpiry: postStop.bucket.waker.expires_ms,
        tickMs: defaults.wakerTickMs, roleTtlMs: defaults.wakerLeaseTtlMs, observationAllowanceMs: evidence.window.allowanceMs }, evidence.observations, peer.node, owner);
      evidence.role = sample; return;
    }
    assert.ok(await clock() < evidence.window.deadline, 'Paused waker preparation timed out');
    await delay(1000); const stopped = await stoppedFailureNode(host, peer, { exit: 0 });
    sample = await storage.observe('prepare-waker', { keys, absentId: peer.node }); sample.stopped = stopped; evidence.observations.push(sample);
  }
}
async function cleanPeerLogs(host, peer, evidence) {
  const canonical = join(host.env.FOGD_HOME, '.fogd/installations', host.project, 'compose.json');
  const logs = await host.run('docker', [...composeArgs(canonical, host.project), 'logs', '--no-color', '--since', peer.startedAt, peer.host]);
  await writeFile(join(host.output, 'preparation-peer.log'), logs, { mode: 0o600, flag: 'wx' });
  assert.doesNotMatch(logs, nativeLogFailure);
  evidence.cleanPeerLog = { file: 'preparation-peer.log', since: peer.startedAt, bytes: Buffer.byteLength(logs) };
}
