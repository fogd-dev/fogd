import { mkdir, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { uuid } from '../build-cache/paths.mjs';
import { syncHostDirectory } from '../runtime/host-directory.mjs';
import { validatePreviewPlan, previewPlanSha256 } from './plan.mjs';
import { previewServiceCommands } from './container-plan.mjs';
import { preparePreviewInputPackage } from './input-package.mjs';
import { previewInputFile } from './input-files.mjs';
import { acquirePreviewHost, guardPreviewHost, requirePreviewHold } from './host-registry.mjs';
import { appendHostRecord, hostRefusal, assertRegisteredPreviewResources } from './host-records.mjs';
import { readPreviewHost } from './host-inventory.mjs';
import { assertPreviewAllocationImage, assertStoppedPreviewGraph } from './stopped-graph.mjs';
import { readPreviewAllocation } from './allocation-state.mjs';

async function allocationRecord(host, plan, allocationId, reservation, options, envelope) {
  const { bound, complete } = await readPreviewAllocation(host, plan, { allocationId, reservation, grantSha256: options.expectedGrantSha256, expiresAt: envelope.grant.expiresAt });
  if (!isDeepStrictEqual((await readdir(bound.canonical)).sort(), ['allocation.complete.json', 'allocation.pending.json'])) hostRefusal('input-state');
  return { bound, complete };
}
async function readbackInputs(bound, identities, snapshot, run) {
  const root = join(bound.canonical, 'input-readback'); await mkdir(root, { mode: 0o700 }); await syncHostDirectory(bound);
  for (const [group, files] of Object.entries(snapshot.files)) {
    const role = group.slice(0, group.lastIndexOf('-')), type = group.endsWith('-trust') ? 'trust' : 'input';
    const target = type === 'trust' ? '/run/fogd-preview-trust' : role === 'controller' ? '/run/fogd-preview-input' : '/run/fogd-preview-service';
    const directory = join(root, group); await mkdir(directory, { mode: 0o700 });
    await run(['cp', `${identities.containers[role]}:${target}/.`, directory]);
    if (!isDeepStrictEqual((await readdir(directory)).sort(), Object.keys(files).sort())) hostRefusal('input-readback');
    for (const [name, expected] of Object.entries(files)) {
      const bytes = await previewInputFile(join(directory, name), Buffer.byteLength(expected));
      if (!bytes.equals(Buffer.from(expected))) hostRefusal('input-readback');
    }
  }
}

// Start only the fixed networkless input installer. Every application service
// must remain never-started; source recheck and runtime admission still gate launch.
export async function installPreviewInputs({ root, plan: input, allocationId, reservation, envelope, bundle, expectedImage, run, ...options }) {
  const plan = validatePreviewPlan(input);
  if (!uuid(allocationId) || !uuid(reservation) || expectedImage !== plan.request.image) hostRefusal('input-state');
  const commands = previewServiceCommands(plan, envelope, options, allocationId);
  const authority = JSON.parse(commands['input-installer'].configuration.command[2]);
  const snapshot = await preparePreviewInputPackage(authority, bundle);
  return guardPreviewHost(async () => {
    const host = await acquirePreviewHost(root, plan.request.engineId); await requirePreviewHold(host, plan, reservation);
    const { bound, complete } = await allocationRecord(host, plan, allocationId, reservation, options, envelope);
    const images = JSON.parse(await run(['image', 'inspect', expectedImage]));
    if (images.length !== 1) hostRefusal('allocation-image');
    assertPreviewAllocationImage(plan, images[0], expectedImage);
    const before = await readPreviewHost(run); assertRegisteredPreviewResources(before, host.records);
    const graph = assertStoppedPreviewGraph(plan, before, images[0], commands, allocationId, complete.identities);
    if (graph.inventorySha256 !== complete.inventorySha256) hostRefusal('input-state');
    const pending = { schema: 1, kind: 'fogd-preview-input-installation', allocationId, reservation, planSha256: previewPlanSha256(plan), grantSha256: options.expectedGrantSha256, packageSha256: snapshot.sha256, inventorySha256: graph.inventorySha256 };
    await host.fence.record('writing'); await appendHostRecord(bound, 'inputs.pending.json', pending);
    const packageFile = await open(join(bound.canonical, 'inputs.package.json'), 'wx', 0o600);
    try { await packageFile.writeFile(snapshot.bytes); await packageFile.sync(); } finally { await packageFile.close(); }
    await syncHostDirectory(bound);
    previewServiceCommands(plan, envelope, options, allocationId);
    const output = await run(['start', '--attach', '--interactive', complete.identities.containers['input-installer']], { inputText: snapshot.bytes.toString('utf8') });
    if (output.trim() !== JSON.stringify({ installed: true, packageSha256: snapshot.sha256 })) hostRefusal('installer-result');
    await readbackInputs(bound, complete.identities, snapshot, run);
    const after = await readPreviewHost(run); previewServiceCommands(plan, envelope, options, allocationId); assertRegisteredPreviewResources(after, host.records);
    const installed = assertStoppedPreviewGraph(plan, after, images[0], commands, allocationId, complete.identities, 'inputs-installed');
    if (installed.inventorySha256 !== graph.inventorySha256) hostRefusal('input-state');
    await appendHostRecord(bound, 'inputs.complete.json', { ...pending, files: snapshot.manifest });
    await host.fence.record('complete'); await host.fence.release();
    return { inputsInstalled: true, allocationId, packageSha256: snapshot.sha256, inventorySha256: installed.inventorySha256,
      executionAuthorized: false, runtimeExecutionAdmitted: false, capacityReserved: true };
  });
}
