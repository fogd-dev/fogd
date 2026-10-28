import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join, basename } from 'node:path';
import { verifyBundle, composeResolved } from '../../../packages/cli/src/recovery/bundle.mjs';
import { verifyDurableBundle, durableSnapshotLayout } from '../../../packages/cli/src/recovery/durable-bundle.mjs';
import { snapshotState } from '../../../packages/cli/src/recovery/snapshot-state.mjs';
import { readPolicyVolume } from '../../../packages/cli/src/runtime/policy-volume.mjs';
import { compareSourceVolumes } from '../recovery/preservation.mjs';
import { recoveryLayout } from '../../../packages/cli/src/recovery/layout.mjs';
import { recoveredData, applicationData } from './recovery-fixtures.mjs';
import { recoveryFence, nativeProcesses } from './recovery-fence.mjs';
import { vmTime, controllerState } from './observations.mjs';
import { stopSelectedHost } from './shutdown.mjs';

export async function normalSnapshot(host, fixture, bundle, expectedAlarm, installations) {
  const point = await backgroundSnapshot(host, fixture.approvals, bundle, [{ app: 'refresh', due: expectedAlarm }], installations);
  return { ...point, prepared: point.manifest.cronRecovery.apps.refresh, preparationLatencyMs: point.manifest.cronRecovery.apps.refresh.completedAt - point.requestedAt, queueMessages: point.sourceObservation.imports.queuePeek.messages };
}

export function verifyRecoveryBundle(host, bundle) {
  return host.entry.routing === 'durable' ? verifyDurableBundle(bundle, host.policy) : verifyBundle(bundle);
}

export async function backgroundSnapshot(host, approvals, bundle, alarms, installations) {
  const fence = await recoveryFence(host, installations), native = await nativeProcesses(host);
  assert.deepEqual(native, host.nativeBaseline, 'Native process changed before snapshot');
  const liveState = await controllerState(host);
  const liveHistory = history(liveState);
  const liveNames = Object.keys(liveState.apps).filter(name => !liveState.apps[name].retirement).sort();
  assert.deepEqual(liveNames, Object.keys(approvals).sort());
  for (const [name, active] of Object.entries(approvals)) {
    assert.equal(liveState.apps[name].active, active.id); assert.equal(liveState.apps[name].slot, active.slot);
    const deployment = liveState.deployments[active.id]; assert.equal(deployment.digest, active.digest); assert.equal(deployment.secretRevision, active.secretRevision);
  }
  const before = await recoveredData(host, approvals);
  for (const observed of Object.values(before)) {
    const pending = observed.databases.flatMap(database => database.data.cron_fault_attempts || []).filter(row => row.outcome === 'pending');
    assert.deepEqual(pending, [], 'Snapshot selection requires quiescent application callbacks');
  }
  const canonicalFile = join(host.env.FOGD_HOME, '.fogd/installations', host.project, 'compose.json');
  const canonical = await readFile(canonicalFile), canonicalBeforeFile = join(host.output, `${basename(bundle)}.canonical-before.json`);
  await writeFile(canonicalBeforeFile, canonical, { mode: 0o600, flag: 'wx' });
  const policy = await readPolicyVolume(host.entry.image, host.config.volumes['runtime-policy'].name, host.config.services.controller.environment);
  assert.deepEqual(policy, host.policy);
  const requestedAt = await vmTime(host);
  assert.equal(new Set(alarms.map(alarm => alarm.app)).size, alarms.length);
  for (const alarm of alarms) { assert.ok(approvals[alarm.app]); assert.ok(alarm.due > requestedAt); }
  // One attempt only. Any preparation failure invalidates the selected timers.
  await host.command(['backup', bundle, '--installation', host.project], { timeout: 300000 });
  const verified = await verifyRecoveryBundle(host, bundle), archived = verified.state || await snapshotState(bundle);
  assert.deepEqual(history(archived), liveHistory, 'Backup changed or dropped retirement history');
  const canonicalAfter = await readFile(canonicalFile), expectedConfig = composeResolved(JSON.parse(canonical));
  assert.ok(isDeepStrictEqual(composeResolved(JSON.parse(canonicalAfter)), expectedConfig), 'Backup changed the installed launch configuration');
  assert.ok(isDeepStrictEqual(verified.config, expectedConfig), 'Snapshot launch configuration differs from the installed configuration');
  const hash = value => createHash('sha256').update(value).digest('hex');
  const canonicalConfiguration = { before: { file: canonicalBeforeFile, sha256: hash(canonical) }, after: { file: canonicalFile, sha256: hash(canonicalAfter) } };
  assert.equal(Object.hasOwn(verified.manifest.files, 'runtime-policy.tar'), false);
  const recorded = { ...verified.manifest.cronRecovery?.apps, ...verified.manifest.queueRecovery?.apps };
  assert.deepEqual(Object.keys(recorded).sort(), Object.keys(approvals).sort());
  for (const name of Object.keys(approvals)) {
    const expectedCron = Boolean(liveState.deployments[approvals[name].id].resources.crons);
    const cron = verified.manifest.cronRecovery?.apps[name], queue = verified.manifest.queueRecovery?.apps[name];
    assert.ok(Boolean(cron) !== Boolean(queue)); assert.equal(Boolean(cron), expectedCron);
    const prepared = cron || queue;
    assert.deepEqual(archived.apps[name][cron ? 'cronSnapshot' : 'queueSnapshot'], prepared);
    assert.equal(prepared.observation.paused, true); assert.ok(prepared.completedAt >= requestedAt);
    if (cron) assert.equal(prepared.observation.nextAlarm, null);
  }
  for (const alarm of alarms) {
    const prepared = verified.manifest.cronRecovery.apps[alarm.app];
    assert.equal(prepared.beforePause.paused, false); assert.equal(prepared.beforePause.nextAlarm, alarm.due);
    assert.ok(prepared.completedAt < alarm.due);
  }
  const shutdown = await stopSelectedHost(host, { alreadyStopped: true }); host.closed = true;
  return { bundle, before: applicationData(before), sourceObservation: before, approvals, manifest: verified.manifest, alarms,
    fence, native, requestedAt, policy, shutdown, canonicalConfiguration,
    retiredHistory: liveHistory };
}

export async function preserveSource(host, point) {
  const layout = host.entry.routing === 'durable' ? durableSnapshotLayout(host.config, host.policy) : recoveryLayout(host.config);
  const names = layout.archiveVolumes;
  const config = { ...host.config, volumes: Object.fromEntries(names.map(name => [name, host.config.volumes[name]])) };
  const compared = await compareSourceVolumes({ config }, point.bundle);
  const policy = await readPolicyVolume(host.entry.image, host.config.volumes['runtime-policy'].name, host.config.services.controller.environment);
  assert.deepEqual(policy, point.policy);
  await verifyRecoveryBundle(host, point.bundle);
  return { ...compared, independentPolicyUnchanged: true };
}

function history(state) {
  return Object.fromEntries(Object.entries(state.apps).filter(([, app]) => app.retirement).map(([name, app]) => [name, structuredClone(app.retirement)]));
}
