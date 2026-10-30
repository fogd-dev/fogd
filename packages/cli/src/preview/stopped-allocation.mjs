import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { uuid } from '../build-cache/paths.mjs';
import { bindHostDirectory, checkHostDirectory, syncHostDirectory } from '../runtime/host-directory.mjs';
import { validatePreviewPlan, previewPlanSha256 } from './plan.mjs';
import { acquirePreviewHost, guardPreviewHost } from './host-registry.mjs';
import { hostRefusal, appendHostRecord, assertRegisteredPreviewResources } from './host-records.mjs';
import { readPreviewHost } from './host-inventory.mjs';
import { assessPreviewAdmission, PreviewAdmissionError } from './admission.mjs';
import { previewServiceCommands } from './container-plan.mjs';
import { assertPreviewAllocationImage, assertStoppedPreviewGraph } from './stopped-graph.mjs';

const resourceLabels = (plan, allocationId) => ({ 'fogd.preview.project': plan.project, 'fogd.preview.config': previewPlanSha256(plan), 'fogd.preview.allocation': allocationId });
const labelArgs = labels => Object.entries(labels).flatMap(([key,value]) => ['--label', `${key}=${value}`]);
function createdId(value) {
  const id = value.trim(); if (!/^[a-f0-9]{64}$/.test(id)) hostRefusal('created-identity'); return id;
}
async function createResources(plan, commands, allocationId, run, valid) {
  const result = { networks: {}, containers: {} }, labels = resourceLabels(plan, allocationId);
  for (const [role, network] of Object.entries(plan.networks)) {
    valid();
    result.networks[role] = createdId(await run(['network', 'create', '--driver', 'bridge', '--subnet', network.ipam.config[0].subnet,
      ...(network.internal ? ['--internal'] : []), ...Object.entries(network.driver_opts).flatMap(([key,value]) => ['--opt', `${key}=${value}`]),
      ...labelArgs({ ...network.labels, ...labels }), network.name]));
  }
  for (const [role, volume] of Object.entries(plan.volumes)) {
    valid();
    if ((await run(['volume', 'create', '--driver', 'local', ...labelArgs({ ...labels, 'fogd.preview.volume': role }), volume.name])).trim() !== volume.name) hostRefusal('created-identity');
  }
  for (const [role, command] of Object.entries(commands)) {
    valid(); result.containers[role] = createdId(await run(command.create));
    for (const connection of command.connect) {
      valid(); await run(['network', 'connect', ...connection.aliases.flatMap(value => ['--alias', value]), connection.network, result.containers[role]]);
    }
  }
  return result;
}

// Only stopped resources are created. Empty input/trust volumes and an image
// identity check do not admit runtime execution or constitute launch readiness.
// Any ambiguous effect retains the allocation journal, hold and host fence.
export async function allocateStoppedPreview({ root, plan: input, reservation, envelope, expectedImage, run, ...options }) {
  const plan = validatePreviewPlan(input), allocationId = randomUUID();
  if (!uuid(reservation)) hostRefusal('reservation');
  if (expectedImage !== plan.request.image) hostRefusal('allocation-image');
  const commands = previewServiceCommands(plan, envelope, options, allocationId), valid = () => previewServiceCommands(plan, envelope, options, allocationId);
  return guardPreviewHost(async () => {
    const host = await acquirePreviewHost(root, plan.request.engineId);
    const held = host.records.find(record => record.id === reservation);
    if (!held || !isDeepStrictEqual(held.plan, plan)) hostRefusal('reservation');
    const before = await readPreviewHost(run); assertRegisteredPreviewResources(before, host.records);
    try { assessPreviewAdmission(plan, before, host.records.filter(record => record !== held).map(record => record.plan)); }
    catch (error) { if (error instanceof PreviewAdmissionError) await host.fence.release(); throw error; }
    const images = JSON.parse(await run(['image', 'inspect', expectedImage]));
    if (!Array.isArray(images) || images.length !== 1) hostRefusal('allocation-image');
    assertPreviewAllocationImage(plan, images[0], expectedImage); valid();
    await host.fence.record('writing'); await checkHostDirectory(host.parent);
    const directory = join(host.allocations.canonical, plan.project); await mkdir(directory, { mode: 0o700 }); await syncHostDirectory(host.allocations);
    const bound = await bindHostDirectory(directory), pending = { schema: 1, kind: 'fogd-preview-stopped-allocation', allocationId, reservation, planSha256: previewPlanSha256(plan), grantSha256: options.expectedGrantSha256, expiresAt: envelope.grant.expiresAt };
    await appendHostRecord(bound, 'allocation.pending.json', pending);
    const created = await createResources(plan, commands, allocationId, run, valid);
    const after = await readPreviewHost(run); valid(); assertRegisteredPreviewResources(after, host.records);
    const graph = assertStoppedPreviewGraph(plan, after, images[0], commands, allocationId, created);
    await appendHostRecord(bound, 'allocation.complete.json', { ...pending, inventorySha256: graph.inventorySha256, identities: graph.identities });
    await host.fence.record('complete'); await host.fence.release();
    return { allocatedStopped: true, allocationId, reservation, inventorySha256: graph.inventorySha256, planSha256: pending.planSha256,
      executionAuthorized: false, runtimeExecutionAdmitted: false, inputsInstalled: false, capacityReserved: true };
  });
}
