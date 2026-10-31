import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { bindHostDirectory } from '../runtime/host-directory.mjs';
import { previewPlanSha256 } from './plan.mjs';
import { readHostRecord, hostRefusal } from './host-records.mjs';

// Immutable allocation identity is shared by installation and shutdown. This is
// not a readiness decision: each operation checks its own phase and actual graph.
export async function readPreviewAllocation(host, plan, { allocationId, reservation, grantSha256, expiresAt }) {
  const bound = await bindHostDirectory(join(host.allocations.canonical, plan.project));
  const pending = await readHostRecord(bound, 'allocation.pending.json'), complete = await readHostRecord(bound, 'allocation.complete.json');
  const expected = { schema: 1, kind: 'fogd-preview-stopped-allocation', allocationId, reservation, planSha256: previewPlanSha256(plan), grantSha256, expiresAt };
  if (!isDeepStrictEqual(pending, expected) || !isDeepStrictEqual(complete, { ...expected, inventorySha256: complete.inventorySha256, identities: complete.identities })) hostRefusal('allocation-state');
  return { bound, complete };
}
