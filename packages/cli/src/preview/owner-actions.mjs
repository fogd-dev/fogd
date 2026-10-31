import { hash, jsonBytes } from '../build-cache/paths.mjs';
import { readPreviewOwnerControl, previewOwnerDocker, verifyPreviewOwnerEngine } from './owner-control.mjs';
import { completePreviewStop, inspectPreviewStatus, releasePreviewMemory } from './teardown.mjs';
import { hostRefusal } from './host-records.mjs';
import { waitForPreviewFence, previewFencePending } from './pending-operation.mjs';

async function retire(input) {
  const before = await waitForPreviewFence(() => inspectPreviewStatus(input));
  if (!before.memoryBudgetHeld) return before;
  if (before.state !== 'stopped' || !before.shutdownOrdered) hostRefusal('teardown-unconfirmed');
  try { await waitForPreviewFence(() => releasePreviewMemory(input)); }
  catch (error) {
    if (error.code !== 'PREVIEW_HOST_REFUSED' || error.reason !== 'reservation') throw error;
    const after = await waitForPreviewFence(() => inspectPreviewStatus(input));
    if (after.memoryBudgetHeld) throw error;
    return after;
  }
  return waitForPreviewFence(() => inspectPreviewStatus(input));
}

export async function performPreviewOwnerAction(action, { directory, allocationId, reason, expectedControlSha256, run }) {
  if (!['status', 'stop', 'retire'].includes(action)) hostRefusal('owner-action');
  const control = await readPreviewOwnerControl(directory, allocationId), input = { ...control, run: run ?? previewOwnerDocker(control.dockerContext) };
  if (expectedControlSha256 !== undefined && hash(jsonBytes(control)) !== expectedControlSha256) hostRefusal('owner-control-changed');
  await verifyPreviewOwnerEngine(control, input.run);
  let result;
  if (action === 'stop') {
    await completePreviewStop(input, { reason });
    result = await waitForPreviewFence(() => inspectPreviewStatus(input));
  } else if (action === 'retire') result = await retire(input);
  else {
    try { result = await inspectPreviewStatus(input); }
    catch (error) {
      if (!previewFencePending(error)) throw error;
      result = { schema: 1, kind: 'fogd-preview-status', allocationId: control.allocationId, preview: control.envelope.grant.preview,
        expiresAt: control.envelope.grant.expiresAt, state: 'pending', runtimeObserved: false, health: 'not-assessed', memoryBudgetHeld: null, executionAuthorized: false };
    }
  }
  return result;
}
