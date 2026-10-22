import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { verifyBundle, composeResolved } from '../../../packages/cli/src/recovery/bundle.mjs';
import { snapshotState } from '../../../packages/cli/src/recovery/snapshot-state.mjs';
import { readPolicyVolume } from '../../../packages/cli/src/runtime/policy-volume.mjs';
import { compareSourceVolumes } from '../recovery/preservation.mjs';
import { recoveryLayout } from '../../../packages/cli/src/recovery/layout.mjs';
import { recoveredData, applicationData } from './recovery-fixtures.mjs';
import { recoveryFence, nativeProcesses } from './recovery-fence.mjs';
import { vmTime } from './observations.mjs';
import { stopSelectedHost } from './shutdown.mjs';

export async function normalSnapshot(host, fixture, bundle, expectedAlarm, installations) {
  const fence = await recoveryFence(host, installations), native = await nativeProcesses(host);
  assert.deepEqual(native, host.nativeBaseline, 'Native process changed before snapshot');
  const before = await recoveredData(host, fixture.approvals);
  const pending = before.refresh.databases.flatMap(database => database.data.cron_fault_attempts || []).filter(row => row.outcome === 'pending');
  assert.deepEqual(pending, [], 'Snapshot selection requires quiescent application callbacks');
  const canonicalFile = join(host.env.FOGD_HOME, '.fogd/installations', host.project, 'compose.json');
  const canonical = await readFile(canonicalFile);
  const policy = await readPolicyVolume(host.entry.image, host.config.volumes['runtime-policy'].name, host.config.services.controller.environment);
  assert.deepEqual(policy, host.policy);
  const requestedAt = await vmTime(host); assert.ok(expectedAlarm > requestedAt);
  // One attempt only. Any preparation failure invalidates this selected timer.
  await host.command(['backup', bundle], { timeout: 300000 });
  const verified = await verifyBundle(bundle), prepared = verified.manifest.cronRecovery.apps.refresh;
  assert.deepEqual(await readFile(canonicalFile), canonical, 'Backup changed the installed launch configuration');
  assert.deepEqual(verified.config, composeResolved(JSON.parse(canonical)));
  assert.equal(prepared.beforePause.paused, false); assert.equal(prepared.beforePause.nextAlarm, expectedAlarm);
  assert.ok(prepared.completedAt < expectedAlarm); assert.ok(prepared.completedAt >= requestedAt);
  assert.equal(prepared.observation.paused, true); assert.equal(prepared.observation.nextAlarm, null);
  assert.ok(verified.manifest.queueRecovery.apps.imports); assert.equal(Object.hasOwn(verified.manifest.files, 'runtime-policy.tar'), false);
  const archived = await snapshotState(bundle);
  assert.deepEqual(archived.apps.refresh.cronSnapshot, prepared);
  assert.equal(archived.apps.imports.queueSnapshot.id, verified.manifest.queueRecovery.apps.imports.id);
  const shutdown = await stopSelectedHost(host, { alreadyStopped: true }); host.closed = true;
  const point = { bundle, before: applicationData(before), sourceObservation: before, approvals: fixture.approvals, manifest: verified.manifest, prepared,
    queueMessages: before.imports.queuePeek.messages, fence, native, requestedAt, preparationLatencyMs: prepared.completedAt - requestedAt, policy, shutdown,
    retiredHistory: Object.fromEntries(Object.entries(archived.apps).filter(([, app]) => app.retirement).map(([name, app]) => [name, structuredClone(app.retirement)])) };
  return point;
}

export async function preserveSource(host, point) {
  const names = recoveryLayout(host.config).archiveVolumes;
  const config = { ...host.config, volumes: Object.fromEntries(names.map(name => [name, host.config.volumes[name]])) };
  const compared = await compareSourceVolumes({ config }, point.bundle);
  const policy = await readPolicyVolume(host.entry.image, host.config.volumes['runtime-policy'].name, host.config.services.controller.environment);
  assert.deepEqual(policy, point.policy);
  await verifyBundle(point.bundle);
  return { ...compared, independentPolicyUnchanged: true };
}
