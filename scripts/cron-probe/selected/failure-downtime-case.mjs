import assert from 'node:assert/strict';
import { beginFailurePhase, firstFailureOccurrence, assertHealthyOccurrence, waitFailureTime } from './failure-phases.mjs';
import { futureFailureWake, completedFailureOccurrence } from './failure-scheduled-cases.mjs';
import { selectedFailureNodes, cutFailureNode, stoppedFailureNode, restartFailureNode } from './failure-containers.mjs';
import { assertFailureLeases } from './failure-authority.mjs';
import { assertAutonomousDowntime } from './failure-downtime.mjs';
import { nativeProcesses } from './recovery-fence.mjs';
import { waitFor } from './https.mjs';

export async function selectedDowntime({ host, active, clock, native, storage, access, evidence }) {
  evidence.phase = await beginFailurePhase(host, active, 'downtime', clock);
  evidence.initial = await native.observe('verify-both');
  evidence.first = await firstFailureOccurrence(host, active, evidence.phase); assertHealthyOccurrence(evidence.first);
  evidence.armed = await futureFailureWake(host, active, evidence.first.time, 60000);
  const due = evidence.armed.status.nextAlarm, nodes = await selectedFailureNodes(host, active.slot); evidence.nodes = nodes; evidence.due = due; assert.ok(!nodes.some(node => node.host === access.clockNode));
  assert.ok(due - await clock() > 15000, 'Full-slot cut missed the armed future tick');
  evidence.killed = [];
  for (const node of nodes) evidence.killed.push(await cutFailureNode(host, node));
  const downAt = Math.max(...evidence.killed.map(row => row.finishedAt)); evidence.downAt = downAt; assert.ok(downAt < due);
  await waitFailureTime(clock, due + 122000);
  evidence.stillStopped = [];
  for (const node of nodes) evidence.stillStopped.push(await stoppedFailureNode(host, node));
  await quietRestart({ host, active, clock, native, storage, access, evidence });
  const checked = assertAutonomousDowntime(evidence); Object.assign(evidence, checked);
  evidence.verified = await waitFor('fresh full membership after downtime', () => native.observe('verify-both'), 90000);
  assertRestartedKeys(host, active, evidence);
  await updateProcesses(host, evidence);
  evidence.overdueCompleted = await completedFailureOccurrence(host, active, due, 'downtime');
  const next = evidence.futureDue; assert.ok(next > evidence.firstReadAt && next !== due);
  evidence.future = await completedFailureOccurrence(host, active, next, 'downtime'); assertHealthyOccurrence(evidence.future);
  return evidence;
}
async function quietRestart({ host, clock, native, storage, access, evidence }) {
  const restartRequestedAt = await clock(); evidence.restartRequestedAt = restartRequestedAt;
  evidence.quietAccessStart = access.events.length; access.beginQuiet(restartRequestedAt);
  try {
    evidence.restarted = [];
    for (const node of evidence.nodes) evidence.restarted.push(await restartFailureNode(host, node));
    evidence.replicasStartedAt = await clock();
    const minimum = evidence.replicasStartedAt + 45000;
    const position = minimum % 60000, boundary = minimum - position;
    const deadline = position < 5000 ? boundary + 5000 : position > 55000 ? boundary + 65000 : minimum;
    evidence.quietUntil = await waitFailureTime(clock, deadline);
    evidence.autonomousWake = await storage.observe('quiet-wake', { time: evidence.due });
    evidence.firstReadAt = await clock();
  } finally { access.endQuiet(evidence.firstReadAt || await clock()); evidence.quietAccessEnd = access.events.length; }
  // No identity, status, ledger or application request precedes this call.
  evidence.firstRead = await native.observe('first-read', { time: evidence.due });
  assert.ok(evidence.firstRead.startedAt >= evidence.firstReadAt);
}
function assertRestartedKeys(host, active, evidence) {
  const keys = evidence.verified.keys;
  for (const node of evidence.nodes) assert.notEqual(keys[node.node], evidence.initial.keys[node.node]);
  for (const sample of [evidence.autonomousWake.bucket, evidence.firstRead.before, evidence.firstRead.after]) assertFailureLeases(host.policy, active.slot, sample.leases, keys, null, sample.at);
  assert.deepEqual(evidence.autonomousWake.observedKeys, keys);
}
async function updateProcesses(host, evidence) {
  const processes = await nativeProcesses(host), restarted = new Set(evidence.nodes.map(node => node.host));
  for (const prior of host.nativeBaseline) {
    const current = processes.find(row => row.host === prior.host); assert.ok(current); assert.equal(current.container, prior.container); assert.equal(current.image, prior.image); assert.equal(current.network, prior.network);
    if (restarted.has(prior.host)) assert.ok(current.pid !== prior.pid || current.start !== prior.start);
    else assert.deepEqual(current, prior);
  }
  host.nativeBaseline = processes; evidence.processesAfter = processes;
}
