import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { readHostRecord, hostRefusal, previewRecordTime } from './host-records.mjs';

export const previewStopGroups = Object.freeze(Object.fromEntries(Object.entries({
  ingress: ['ingress'], management: ['gateway', 'controller', 'input-installer', 'bucket-init'],
  writers: ['slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b'], storage: ['minio'],
}).map(([phase, roles]) => [phase, Object.freeze(roles)])));

export const previewStorageRequired = roles => ['controller', 'bucket-init', ...previewStopGroups.writers]
  .some(role => roles[role].State.Status !== 'created' || !/^0001-01-01T00:00:00(?:\.0+)?Z$/.test(roles[role].State.StartedAt));

export const previewTeardownPending = allocation => ({ schema: 1, kind: 'fogd-preview-teardown', allocationId: allocation.allocationId,
  reservation: allocation.reservation, planSha256: allocation.planSha256, grantSha256: allocation.grantSha256,
  expiresAt: allocation.expiresAt, inventorySha256: allocation.inventorySha256 });
const same = (actual, expected) => { if (!isDeepStrictEqual(actual, expected)) hostRefusal('teardown-unconfirmed'); };

function phaseProof(step, phase, roles, complete) {
  if (typeof step.storageRunning !== 'boolean' || phase === 'storage' && step.storageRunning ||
    complete.ordered && complete.storageRequired && phase !== 'storage' && !step.storageRunning) hostRefusal('teardown-unconfirmed');
  same(step, { schema: 1, phase, stopped: Object.fromEntries(roles.map(role => [role, complete.stopped[role]])), storageRunning: step.storageRunning });
}

export async function optionalPreviewRecord(bound, name) {
  try { await lstat(join(bound.canonical, name)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const value = await readHostRecord(bound, name);
  if (!value || typeof value !== 'object' || Array.isArray(value)) hostRefusal('record');
  return value;
}

// Completed state can be observed again, never replayed. Partial, malformed or
// changed proof cannot become permission to issue another stop sequence.
export async function readCompletedPreviewTeardown(bound, allocation) {
  const complete = await optionalPreviewRecord(bound, 'teardown.complete.json');
  const pending = await optionalPreviewRecord(bound, 'teardown.pending.json');
  if (!complete) { if (pending) hostRefusal('teardown-unconfirmed'); return null; }
  same(pending, previewTeardownPending(allocation));
  if (typeof complete.ordered !== 'boolean' || typeof complete.storageRequired !== 'boolean' || !previewRecordTime(complete.observedAt) ||
    !complete.storageRequired && !complete.ordered) hostRefusal('teardown-unconfirmed');
  same(complete, { ...pending, ordered: complete.ordered, storageRequired: complete.storageRequired, stopped: allocation.identities.containers,
    observedAt: complete.observedAt, memoryBudgetHeld: true, resourcesRetained: true, namespaceReusable: false, dataDurability: 'not-assessed' });
  for (const [phase, roles] of Object.entries(previewStopGroups)) {
    const step = await readHostRecord(bound, `teardown.${phase}.json`);
    phaseProof(step, phase, roles, complete);
  }
  return complete;
}
