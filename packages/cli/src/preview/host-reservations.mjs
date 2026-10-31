import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindHostDirectory, checkHostDirectory, syncHostDirectory } from '../runtime/host-directory.mjs';
import { validatePreviewPlan, previewPlanSha256 } from './plan.mjs';
import { assessPreviewAdmission, PreviewAdmissionError } from './admission.mjs';
import { readPreviewHost } from './host-inventory.mjs';
import { hostRefusal, appendHostRecord, assertRegisteredPreviewResources } from './host-records.mjs';

import { previewHostLocation, previewHostRecord, guardPreviewHost, acquirePreviewHost, acquireFreshPreviewHostFence } from './host-registry.mjs';

// One configured private root per local owner/engine. Never recreate a missing or
// damaged ledger from Docker emptiness; initialization is an explicit fresh action.
export async function initializePreviewHost({ root, engineId, run }) {
  return guardPreviewHost(async () => {
    const { parent, directory } = await previewHostLocation(root, engineId);
    await mkdir(directory, { mode: 0o700 }); await syncHostDirectory(parent);
    const bound = await bindHostDirectory(directory), fence = await acquireFreshPreviewHostFence(directory, engineId);
    const observed = await readPreviewHost(run);
    if (observed.host.ID !== engineId) hostRefusal('engine');
    assertRegisteredPreviewResources(observed, []);
    await fence.record('writing');
    for (const name of ['holds', 'allocations']) await mkdir(join(directory, name), { mode: 0o700 });
    await syncHostDirectory(bound);
    await appendHostRecord(bound, 'host.json', previewHostRecord(engineId, parent));
    await fence.record('complete'); await fence.release();
    return { initialized: true, engineId, capacityReserved: false, executionAuthorized: false };
  });
}

// The hold is durable before returning. There is deliberately no release or
// expiry shortcut: teardown must later prove reclamation before freeing it.
export async function reservePreviewHost({ root, plan: input, run }) {
  const plan = validatePreviewPlan(input), engineId = plan.request.engineId;
  return guardPreviewHost(async () => {
    const { parent, bound, holds, records, heldRecords, fence } = await acquirePreviewHost(root, engineId);
    if (records.length >= 512) { await fence.release(); hostRefusal('hold-limit'); }
    let eligibility;
    try {
      const observed = await readPreviewHost(run);
      assertRegisteredPreviewResources(observed, records);
      eligibility = assessPreviewAdmission(plan, observed, heldRecords.map(record => record.plan));
    }
    catch (error) { if (error instanceof PreviewAdmissionError) await fence.release(); throw error; }
    const record = { schema: 1, kind: 'fogd-preview-host-hold', id: randomUUID(), createdAt: new Date().toISOString(), planSha256: previewPlanSha256(plan), plan };
    await fence.record('writing');
    await checkHostDirectory(bound); await checkHostDirectory(parent);
    await appendHostRecord(holds, plan.project + '.json', record);
    await fence.record('complete'); await fence.release();
    return { engineId, reservation: record.id, planSha256: record.planSha256, capacityReserved: true, executionAuthorized: false, memory: eligibility.memory };
  });
}

export async function inspectPreviewHostReservations({ root, engineId }) {
  return guardPreviewHost(async () => {
    const { records, fence } = await acquirePreviewHost(root, engineId);
    await fence.release(); return records;
  });
}
