import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { hash } from '../build-cache/paths.mjs';
import { bindHostDirectory, checkHostDirectory } from '../runtime/host-directory.mjs';
import { acquireHostOperationFence } from '../runtime/launch-fence.mjs';
import { PreviewAdmissionError } from './admission.mjs';
import { PreviewHostError, hostRefusal, readHostRecord, readHostHolds } from './host-records.mjs';
import { releasedPreviewMemory } from './memory-state.mjs';

const checkedEngine = engineId => {
  if (typeof engineId !== 'string' || !engineId.length || engineId.length > 256 || /[\x00-\x20\x7f]/.test(engineId)) hostRefusal('engine');
  return engineId;
};
const identity = engineId => ({ project: 'fogd-preview-host', installation: hash(checkedEngine(engineId)) });
export async function previewHostLocation(root, engineId) {
  const parent = await bindHostDirectory(root), directory = join(parent.canonical, hash(checkedEngine(engineId)));
  return { parent, directory };
}
export const previewHostRecord = (engineId, parent) => ({ schema: 1, kind: 'fogd-preview-host', engineId, root: parent.canonical });
async function layout(parent, directory, engineId) {
  await checkHostDirectory(parent);
  const bound = await bindHostDirectory(directory), names = (await readdir(directory)).sort();
  if (!isDeepStrictEqual(names, ['allocations', 'holds', 'host.json', 'launch.pending.json'])) hostRefusal('layout');
  if (!isDeepStrictEqual(await readHostRecord(bound, 'host.json'), previewHostRecord(engineId, parent))) hostRefusal('engine');
  return { bound, holds: await bindHostDirectory(join(directory, 'holds')), allocations: await bindHostDirectory(join(directory, 'allocations')) };
}
export async function guardPreviewHost(work) {
  try { return await work(); }
  catch (error) {
    if (error instanceof PreviewHostError || error instanceof PreviewAdmissionError) throw error;
    throw new PreviewHostError(error.code === 'FENCE_EXISTS' ? 'pending' : 'uncertain');
  }
}

export async function acquirePreviewHost(root, engineId) {
  const { parent, directory } = await previewHostLocation(root, engineId);
  const fence = await acquireHostOperationFence(directory, identity(engineId));
  const state = await layout(parent, directory, engineId), records = await readHostHolds(state.holds, engineId);
  const releasedProjects = await releasedPreviewMemory(state.allocations, records), heldRecords = records.filter(record => !releasedProjects.includes(record.plan.project));
  return { parent, ...state, records, heldRecords, releasedProjects, fence };
}
export const acquireFreshPreviewHostFence = (directory, engineId) => acquireHostOperationFence(directory, identity(engineId));

export async function requirePreviewHold(host, plan, reservation) {
  const held = host.heldRecords.find(record => record.id === reservation);
  if (!held || !isDeepStrictEqual(held.plan, plan)) { await host.fence.release(); hostRefusal('reservation'); }
  return held;
}
