import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes } from '../build-cache/paths.mjs';
import { bindHostDirectory } from '../runtime/host-directory.mjs';
import { readPreviewOwnerControl } from './owner-control.mjs';
import { previewHostLocation, previewHostRecord } from './host-registry.mjs';
import { readHostHolds, readHostRecord, hostRefusal } from './host-records.mjs';
import { readPreviewAllocation } from './allocation-state.mjs';
import { previewAllocationObserver } from './allocation-observation.mjs';

async function markerPresent(directory) {
  try { await lstat(join(directory, 'launch.pending.json')); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function records(control) {
  const { parent, directory } = await previewHostLocation(control.root, control.plan.request.engineId), bound = await bindHostDirectory(directory);
  if (!isDeepStrictEqual(await readHostRecord(bound, 'host.json'), previewHostRecord(control.plan.request.engineId, parent))) hostRefusal('engine');
  const rows = await readHostHolds(await bindHostDirectory(join(directory, 'holds')), control.plan.request.engineId);
  const hold = rows.find(row => row.id === control.reservation);
  if (!hold || !isDeepStrictEqual(hold.plan, control.plan)) hostRefusal('reservation');
  const { complete } = await readPreviewAllocation({ allocations: await bindHostDirectory(join(directory, 'allocations')) }, control.plan,
    { allocationId: control.allocationId, reservation: control.reservation, grantSha256: control.expectedGrantSha256, expiresAt: control.envelope.grant.expiresAt });
  return { rows, complete, fingerprints: { hold: hash(jsonBytes(hold)), allocation: hash(jsonBytes(complete)) }, pendingOperation: await markerPresent(directory) };
}

// Read-only ownership proof, independent of operation admission. A pending
// marker may be observed, including torn metadata; it is never parsed or cleared.
export function previewLogObservation(directory, control, run) {
  const controlSha256 = hash(jsonBytes(control)), observe = previewAllocationObserver({ ...control, run });
  return async () => {
    const current = await readPreviewOwnerControl(directory, control.allocationId);
    if (hash(jsonBytes(current)) !== controlSha256) hostRefusal('owner-control-changed');
    const state = await records(control), actual = await observe(state.complete, state.rows, 'operating');
    return { controlSha256, ...state.fingerprints, inventorySha256: actual.graph.inventorySha256, pendingOperation: state.pendingOperation,
      roles: Object.fromEntries(Object.entries(actual.roles).map(([role, container]) => [role, { id: container.Id, state: container.State.Status }])) };
  };
}
export function samePreviewLogScope(before, after) {
  return ['controlSha256', 'hold', 'allocation', 'inventorySha256'].every(key => before[key] === after[key]) &&
    isDeepStrictEqual(Object.fromEntries(Object.entries(before.roles).map(([role, value]) => [role, value.id])),
      Object.fromEntries(Object.entries(after.roles).map(([role, value]) => [role, value.id])));
}
