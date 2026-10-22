import assert from 'node:assert/strict';
import { join } from 'node:path';
import { recoveryTarget } from './recovery-target.mjs';
import { assertArchivedPrefix } from './retirement-bucket.mjs';
import { coldRecovery, acknowledgeRecovery } from './recovery-holds.mjs';
import { controllerState } from './observations.mjs';
import { fleetProofs, retainedHistory } from './retirement-steps.mjs';
import { controllerFiles } from '../retirement/preservation.mjs';
import { stopSelectedHost } from './shutdown.mjs';
import { verifyNativeTimingEnvironment } from '../sealed/defaults.mjs';

export async function auditSnapshot(context, host, point, label, retained = {}) {
  assert.deepEqual(Object.keys(retained).sort(), Object.keys(point.retiredHistory).sort());
  const { source, installations } = context; context.phase = label;
  const audit = await recoveryTarget(host, point.bundle, join(source.output, label), installations, point.manifest.images); installations.push(audit);
  const record = { project: audit.project, policy: audit.policy, initialServices: audit.initialServices, cold: await coldRecovery(audit, point, installations) };
  record.timing = await verifyNativeTimingEnvironment({ ...audit, slots: audit.policy.fleets.map(fleet => ({ nodes: fleet.nodes.map(node => node.host) })) });
  const reader = { identity: { image: audit.entry.image }, config: audit.config };
  record.privateFilesBefore = await controllerFiles(reader);
  record.sourceArchivePrefixes = {};
  for (const [name, expected] of Object.entries(point.retiredHistory)) record.sourceArchivePrefixes[name] = await assertArchivedPrefix(audit, point, expected.previous.prefix);
  record.retainedBefore = await retainedHistory(audit, retained, record.privateFilesBefore, false);
  const empty = Object.keys(point.approvals).length === 0;
  record.coldProofs = await fleetProofs(audit, empty);
  record.acknowledged = await acknowledgeRecovery(audit, point, installations);
  record.warmProofs = await fleetProofs(audit, empty); assert.deepEqual(record.coldProofs.keys, record.warmProofs.keys);
  const state = await controllerState(audit);
  assert.deepEqual(Object.keys(state.apps).filter(name => state.apps[name].retirement).sort(), Object.keys(point.retiredHistory).sort());
  for (const [name, expected] of Object.entries(point.retiredHistory)) {
    const app = state.apps[name]; assert.deepEqual(app.retirement, expected);
    assert.equal(app.slot, null); assert.equal(app.route, 'retired'); assert.equal(app.active, expected.deployment);
  }
  if (empty) assert.ok(Object.values(state.apps).every(app => app.retirement && app.route === 'retired' && app.slot === null));
  record.retainedAfter = await retainedHistory(audit, retained, record.privateFilesBefore);
  record.privateFilesAfter = await controllerFiles(reader); assert.deepEqual(record.privateFilesAfter, record.privateFilesBefore);
  record.shutdown = await stopSelectedHost(audit); audit.closed = true;
  return record;
}
