import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { hash } from '../build-cache/paths.mjs';
import { bindHostDirectory, checkHostDirectory, syncHostDirectory } from '../runtime/host-directory.mjs';
import { acquireHostOperationFence } from '../runtime/launch-fence.mjs';
import { validatePreviewPlan, previewPlanSha256 } from './plan.mjs';
import { assessPreviewAdmission, PreviewAdmissionError } from './admission.mjs';
import { readPreviewHost } from './host-inventory.mjs';
import { PreviewHostError, hostRefusal, readHostRecord, appendHostRecord, readHostHolds, assertRegisteredPreviewResources } from './host-records.mjs';

const checkedEngine = engineId => {
  if (typeof engineId !== 'string' || !engineId.length || engineId.length > 256 || /[\x00-\x20\x7f]/.test(engineId)) hostRefusal('engine');
  return engineId;
};
const identity = engineId => ({ project: 'fogd-preview-host', installation: hash(checkedEngine(engineId)) });
async function location(root, engineId) {
  const parent = await bindHostDirectory(root), directory = join(parent.canonical, hash(checkedEngine(engineId)));
  return { parent, directory };
}
const hostRecord = (engineId, parent) => ({ schema: 1, kind: 'fogd-preview-host', engineId, root: parent.canonical });
async function layout(parent, directory, engineId) {
  await checkHostDirectory(parent);
  const bound = await bindHostDirectory(directory), names = (await readdir(directory)).sort();
  if (!isDeepStrictEqual(names, ['holds', 'host.json', 'launch.pending.json'])) hostRefusal('layout');
  if (!isDeepStrictEqual(await readHostRecord(bound, 'host.json'), hostRecord(engineId, parent))) hostRefusal('engine');
  return { bound, holds: await bindHostDirectory(join(directory, 'holds')) };
}
async function guarded(work) {
  try { return await work(); }
  catch (error) {
    if (error instanceof PreviewHostError || error instanceof PreviewAdmissionError) throw error;
    throw new PreviewHostError(error.code === 'FENCE_EXISTS' ? 'pending' : 'uncertain');
  }
}

// One configured private root per local owner/engine. Never recreate a missing or
// damaged ledger from Docker emptiness; initialization is an explicit fresh action.
export async function initializePreviewHost({ root, engineId, run }) {
  return guarded(async () => {
    const { parent, directory } = await location(root, engineId);
    await mkdir(directory, { mode: 0o700 }); await syncHostDirectory(parent);
    const bound = await bindHostDirectory(directory), fence = await acquireHostOperationFence(directory, identity(engineId));
    const observed = await readPreviewHost(run);
    if (observed.host.ID !== engineId) hostRefusal('engine');
    assertRegisteredPreviewResources(observed, []);
    await fence.record('writing');
    await mkdir(join(directory, 'holds'), { mode: 0o700 }); await syncHostDirectory(bound);
    await appendHostRecord(bound, 'host.json', hostRecord(engineId, parent));
    await fence.record('complete'); await fence.release();
    return { initialized: true, engineId, capacityReserved: false, executionAuthorized: false };
  });
}

// The hold is durable before returning. There is deliberately no release or
// expiry shortcut: teardown must later prove reclamation before freeing it.
export async function reservePreviewHost({ root, plan: input, run }) {
  const plan = validatePreviewPlan(input), engineId = plan.request.engineId;
  return guarded(async () => {
    const { parent, directory } = await location(root, engineId);
    const fence = await acquireHostOperationFence(directory, identity(engineId));
    const { bound, holds } = await layout(parent, directory, engineId), records = await readHostHolds(holds, engineId);
    if (records.length >= 512) { await fence.release(); hostRefusal('hold-limit'); }
    const observed = await readPreviewHost(run);
    assertRegisteredPreviewResources(observed, records);
    let eligibility;
    try { eligibility = assessPreviewAdmission(plan, observed, records.map(record => record.plan)); }
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
  return guarded(async () => {
    const { parent, directory } = await location(root, engineId), fence = await acquireHostOperationFence(directory, identity(engineId));
    const { holds } = await layout(parent, directory, engineId), records = await readHostHolds(holds, engineId);
    await fence.release(); return records;
  });
}
