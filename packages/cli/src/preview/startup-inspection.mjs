import { assertCurrentPreviewStorage } from './storage-binding.mjs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { uuid } from '../build-cache/paths.mjs';
import { validatePreviewPlan, previewPlanSha256 } from './plan.mjs';
import { previewServiceCommands } from './container-plan.mjs';
import { readPreviewInputs } from './inputs.mjs';
import { assertCurrentPreviewSource } from './decision.mjs';
import { preparePreviewInputPackage, previewInputPackageLimit } from './input-package.mjs';
import { previewInputFile } from './input-files.mjs';
import { readPreviewInputMounts } from './input-readback.mjs';
import { acquirePreviewHost, guardPreviewHost, requirePreviewHold } from './host-registry.mjs';
import { readPreviewAllocation } from './allocation-state.mjs';
import { readHostRecord, hostRefusal, assertRegisteredPreviewResources } from './host-records.mjs';
import { readPreviewHost } from './host-inventory.mjs';
import { assertPreviewAllocationImage, inspectPreviewGraph } from './stopped-graph.mjs';
import { assessPreviewMemory } from './admission.mjs';

async function installedInputs(bound, authority, allocation, reservation) {
  const names = ['allocation.complete.json', 'allocation.pending.json', 'input-readback', 'inputs.complete.json', 'inputs.package.json', 'inputs.pending.json'];
  if (!isDeepStrictEqual((await readdir(bound.canonical)).sort(), names)) hostRefusal('startup-state');
  const snapshot = await preparePreviewInputPackage(authority, await previewInputFile(join(bound.canonical, 'inputs.package.json'), previewInputPackageLimit));
  const pending = { schema: 1, kind: 'fogd-preview-input-installation', allocationId: allocation.allocationId, reservation,
    planSha256: allocation.planSha256, grantSha256: authority.expectedGrantSha256, packageSha256: snapshot.sha256, inventorySha256: allocation.inventorySha256 };
  if (!isDeepStrictEqual(await readHostRecord(bound, 'inputs.pending.json'), pending) ||
    !isDeepStrictEqual(await readHostRecord(bound, 'inputs.complete.json'), { ...pending, files: snapshot.manifest })) hostRefusal('startup-state');
  return snapshot;
}

// A point-in-time inspection, never a reusable start authorization. Runtime
// admission, final launch and deadline orchestration remain separate gates.
export async function openPreviewStartup({ root, plan: input, allocationId, reservation, envelope, expectedImage, directory, env, run, runStorageHost, ...options }) {
  const plan = validatePreviewPlan(input);
  if (!uuid(allocationId) || !uuid(reservation) || expectedImage !== plan.request.image) hostRefusal('startup-target');
  const commands = previewServiceCommands(plan, envelope, options, allocationId);
  const inputs = await readPreviewInputs(directory, plan.request.preparationSha256);
  const authority = JSON.parse(commands['input-installer'].configuration.command[2]);
  return guardPreviewHost(async () => {
    const host = await acquirePreviewHost(root, plan.request.engineId), held = await requirePreviewHold(host, plan, reservation);
    let temporary;
    try {
      const { bound, complete } = await readPreviewAllocation(host, plan, { allocationId, reservation, grantSha256: options.expectedGrantSha256, expiresAt: envelope.grant.expiresAt });
      const images = JSON.parse(await run(['image', 'inspect', expectedImage]));
      if (!Array.isArray(images) || images.length !== 1) hostRefusal('allocation-image');
      assertPreviewAllocationImage(plan, images[0], expectedImage);
      const observe = async (phase = 'inputs-installed') => {
        await assertCurrentPreviewStorage(plan, runStorageHost, phase === 'inputs-installed' ? 'installed' : 'any');
        const observed = await readPreviewHost(run); assertRegisteredPreviewResources(observed, host.records);
        const graph = inspectPreviewGraph(plan, observed, images[0], commands, allocationId, complete.identities, phase);
        if (graph.inventorySha256 !== complete.inventorySha256) hostRefusal('startup-target');
        return { observed, graph, roles: Object.fromEntries(Object.entries(plan.services).map(([role, service]) => [role, observed.containers.find(value => value.Name === '/' + service.name)])) };
      };
      await observe();
      const snapshot = await installedInputs(bound, authority, complete, reservation);
      temporary = await mkdtemp(join(tmpdir(), 'fogd-preview-startup-'));
      await readPreviewInputMounts(temporary, complete.identities, snapshot, run);
      await assertCurrentPreviewSource(inputs, env);
      previewServiceCommands(plan, envelope, options, allocationId);
      const { observed } = await observe(); previewServiceCommands(plan, envelope, options, allocationId);
      const eligibility = assessPreviewMemory(plan, observed, host.heldRecords.filter(record => record !== held).map(record => record.plan));
      const inspection = { startupInspected: true, allocationId, planSha256: previewPlanSha256(plan), inventorySha256: complete.inventorySha256, packageSha256: snapshot.sha256,
        source: inputs.preparation.source, expiresAt: envelope.grant.expiresAt, memory: eligibility.memory,
        executionAuthorized: false, runtimeExecutionAdmitted: false, capacityReserved: true };
      return { inspection, plan, host, held, bound, complete, commands, snapshot, inputs, image: images[0], observe };
    } catch (error) { await host.fence.release(); throw error; } finally {
      if (temporary) await rm(temporary, { recursive: true });
    }
  });
}

export async function inspectPreviewStartup(input) {
  const value = await openPreviewStartup(input);
  await value.host.fence.release();
  return value.inspection;
}
