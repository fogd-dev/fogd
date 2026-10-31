import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes, digest, uuid } from '../build-cache/paths.mjs';
import { bindHostDirectory } from '../runtime/host-directory.mjs';
import { readHostRecord, hostRefusal, previewRecordTime as time } from './host-records.mjs';
import { readCompletedPreviewTeardown } from './teardown-state.mjs';

export { previewStopGroups, previewStorageRequired } from './teardown-state.mjs';
const same = (actual, expected) => { if (!isDeepStrictEqual(actual, expected)) hostRefusal('memory-release-state'); };
function releaseClock(value) {
  if (!uuid(value.allocationId) || !digest(value.inventorySha256) || !time(value.expiresAt) || !time(value.releasedAt) ||
    Date.parse(value.expiresAt) > Date.parse(value.releasedAt) || Date.parse(value.releasedAt) > Date.now()) hostRefusal('memory-release-state');
}
export async function validatePreviewMemoryRelease(bound, hold, value) {
  const allocation = await readHostRecord(bound, 'allocation.pending.json'), allocated = await readHostRecord(bound, 'allocation.complete.json');
  const complete = await readCompletedPreviewTeardown(bound, allocated);
  if (!complete?.ordered) hostRefusal('memory-release-state');
  releaseClock(value);
  same(value, { schema: 1, kind: 'fogd-preview-memory-release', allocationId: allocation.allocationId, reservation: hold.id, planSha256: hold.planSha256,
    expiresAt: allocation.expiresAt, releasedAt: value.releasedAt, allocationSha256: hash(jsonBytes(allocated)), teardownSha256: hash(jsonBytes(complete)), inventorySha256: allocated.inventorySha256, namespaceReusable: false });
  if (!digest(allocation.grantSha256) || !isDeepStrictEqual(Object.keys(allocated.identities.containers).sort(), Object.keys(hold.plan.services).sort())) hostRefusal('memory-release-state');
  same(allocation, { schema: 1, kind: 'fogd-preview-stopped-allocation', allocationId: value.allocationId, reservation: hold.id, planSha256: hold.planSha256, grantSha256: allocation.grantSha256, expiresAt: value.expiresAt });
  same(allocated, { ...allocation, inventorySha256: value.inventorySha256, identities: allocated.identities });
  if (Date.parse(complete.observedAt) > Date.parse(value.releasedAt)) hostRefusal('memory-release-state');
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
