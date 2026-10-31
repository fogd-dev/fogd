import { isDeepStrictEqual } from 'node:util';
import { validatePreviewPlan } from './plan.mjs';
import { bindPreviewRuntime } from './runtime-catalog.mjs';
import { readPreviewInputs } from './inputs.mjs';
import { assertCurrentPreviewSource } from './decision.mjs';
import { previewServiceCommands } from './container-plan.mjs';
import { preparePreviewInputPackage } from './input-package.mjs';
import { reservePreviewHost } from './host-reservations.mjs';
import { allocateStoppedPreview } from './stopped-allocation.mjs';
import { installPreviewInputs } from './input-installation.mjs';
import { runPreviewAllocation } from './lifecycle.mjs';
import { checkPreviewOwnerControlLocation, writePreviewOwnerControl } from './owner-control.mjs';
import { hostRefusal } from './host-records.mjs';

function live(input) {
  if (input.signal?.aborted) hostRefusal('launch-cancelled');
  return previewServiceCommands(input.plan, input.envelope, input);
}

async function launchInputs(input) {
  if (typeof input.run !== 'function' || typeof input.runStorageHost !== 'function' ||
    input.signal !== undefined && !(input.signal instanceof AbortSignal)) hostRefusal('launch-target');
  if (input.signal?.aborted) hostRefusal('launch-cancelled');
  const plan = validatePreviewPlan(input.plan);
  bindPreviewRuntime(plan, input.runtime, input.candidateEnrollment);
  if (input.expectedImage !== undefined && input.expectedImage !== plan.request.image) hostRefusal('launch-target');
  const selected = { ...input, plan, envelope: structuredClone(input.envelope), secretValues: structuredClone(input.secretValues),
    env: { ...input.env }, ownerControl: structuredClone(input.ownerControl), expectedImage: plan.request.image };
  const commands = live(selected), authority = JSON.parse(commands['input-installer'].configuration.command[2]);
  const snapshot = await preparePreviewInputPackage(authority, input.bundle);
  const inputs = await readPreviewInputs(selected.directory, plan.request.preparationSha256);
  const artifact = JSON.parse(snapshot.bytes).artifact;
  artifact.files.sort((a, b) => a.path.localeCompare(b.path));
  if (!isDeepStrictEqual(inputs.preparation, plan.request.preparation) ||
    !isDeepStrictEqual(inputs.artifact, artifact)) hostRefusal('launch-inputs');
  await checkPreviewOwnerControlLocation(selected, selected.ownerControl);
  await assertCurrentPreviewSource(inputs, selected.env, { signal: selected.signal });
  live(selected);
  return { ...selected, bundle: snapshot.bytes };
}

// One fresh attempt only. Existing component fences and holds block replay after
// unknown effects. No automatic stop, deletion or reservation release on failure.
// Candidate enrollment remains an explicit owned-qualification API option.
export async function provisionAndRunPreview(input) {
  const selected = await launchInputs(input);
  const held = await reservePreviewHost(selected);
  live(selected);
  const allocated = await allocateStoppedPreview({ ...selected, reservation: held.reservation });
  const allocation = { ...selected, reservation: held.reservation, allocationId: allocated.allocationId };
  const control = await writePreviewOwnerControl(allocation, selected.ownerControl);
  live(allocation);
  await installPreviewInputs(allocation);
  live(allocation);
  const active = await runPreviewAllocation({ ...allocation, ownerControl: undefined });
  return { ready: { ...active.ready, control }, completion: active.completion };
}
