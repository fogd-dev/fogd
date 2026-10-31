import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes, digest, uuid } from '../build-cache/paths.mjs';
import { bindHostDirectory } from '../runtime/host-directory.mjs';
import { readHostRecord, hostRefusal } from './host-records.mjs';

export const previewStopGroups = Object.freeze(Object.fromEntries(Object.entries({
  ingress: ['ingress'], management: ['gateway', 'controller', 'input-installer', 'bucket-init'],
  writers: ['slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b'], storage: ['minio'],
}).map(([phase, roles]) => [phase, Object.freeze(roles)])));

// A late observation cannot establish shutdown order for earlier writers.
// The input installer writes authority files and does not depend on S3.
export const previewStorageRequired = roles => ['controller', 'bucket-init', ...previewStopGroups.writers]
  .some(role => roles[role].State.Status !== 'created' || !/^0001-01-01T00:00:00(?:\.0+)?Z$/.test(roles[role].State.StartedAt));
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const same = (actual, expected) => { if (!isDeepStrictEqual(actual, expected)) hostRefusal('memory-release-state'); };
function releaseClock(value) {
  if (!uuid(value.allocationId) || !digest(value.inventorySha256) || !time(value.expiresAt) || !time(value.releasedAt) ||
    Date.parse(value.expiresAt) > Date.parse(value.releasedAt) || Date.parse(value.releasedAt) > Date.now()) hostRefusal('memory-release-state');
}
function phaseProof(step, phase, roles, complete) {
  if (typeof step.storageRunning !== 'boolean' || phase === 'storage' && step.storageRunning || complete.storageRequired && phase !== 'storage' && !step.storageRunning) hostRefusal('memory-release-state');
  same(step, { schema: 1, phase, stopped: Object.fromEntries(roles.map(role => [role, complete.stopped[role]])), storageRunning: step.storageRunning });
}

export async function validatePreviewMemoryRelease(bound, hold, value) {
  const allocation = await readHostRecord(bound, 'allocation.pending.json'), allocated = await readHostRecord(bound, 'allocation.complete.json');
  const pending = await readHostRecord(bound, 'teardown.pending.json'), complete = await readHostRecord(bound, 'teardown.complete.json');
  releaseClock(value);
  same(value, { schema: 1, kind: 'fogd-preview-memory-release', allocationId: allocation.allocationId, reservation: hold.id, planSha256: hold.planSha256,
    expiresAt: allocation.expiresAt, releasedAt: value.releasedAt, allocationSha256: hash(jsonBytes(allocated)), teardownSha256: hash(jsonBytes(complete)), inventorySha256: allocated.inventorySha256, namespaceReusable: false });
  if (!digest(allocation.grantSha256) || !isDeepStrictEqual(Object.keys(allocated.identities.containers).sort(), Object.keys(hold.plan.services).sort())) hostRefusal('memory-release-state');
  same(allocation, { schema: 1, kind: 'fogd-preview-stopped-allocation', allocationId: value.allocationId, reservation: hold.id, planSha256: hold.planSha256, grantSha256: allocation.grantSha256, expiresAt: value.expiresAt });
  same(allocated, { ...allocation, inventorySha256: value.inventorySha256, identities: allocated.identities });
  same(pending, { schema: 1, kind: 'fogd-preview-teardown', allocationId: value.allocationId, reservation: hold.id, planSha256: hold.planSha256,
    grantSha256: allocation.grantSha256, expiresAt: value.expiresAt, inventorySha256: value.inventorySha256 });
  if (typeof complete.storageRequired !== 'boolean' || !time(complete.observedAt) || Date.parse(complete.observedAt) > Date.parse(value.releasedAt)) hostRefusal('memory-release-state');
  same(complete, { ...pending, ordered: true, storageRequired: complete.storageRequired, stopped: allocated.identities.containers, observedAt: complete.observedAt,
    memoryBudgetHeld: true, resourcesRetained: true, namespaceReusable: false, dataDurability: 'not-assessed' });
  for (const [phase, roles] of Object.entries(previewStopGroups)) {
    const step = await readHostRecord(bound, `teardown.${phase}.json`);
    phaseProof(step, phase, roles, complete);
  }
  return hold.plan.project;
}

// Missing retirement is still a full hold. Presence must validate completely;
// malformed/partial records can never be interpreted as released capacity.
export async function releasedPreviewMemory(allocations, records) {
  const projects = [];
  for (const hold of records) {
    const directory = join(allocations.canonical, hold.plan.project);
    try { await lstat(join(directory, 'memory.released.json')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const bound = await bindHostDirectory(directory);
    projects.push(await validatePreviewMemoryRelease(bound, hold, await readHostRecord(bound, 'memory.released.json')));
  }
  return projects;
}
