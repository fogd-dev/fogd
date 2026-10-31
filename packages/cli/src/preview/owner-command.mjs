import { parseArgs } from 'node:util';
import { uuid } from '../build-cache/paths.mjs';
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

export async function previewOwnerCommand(action, args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    control: { type: 'string' }, ...(action === 'stop' ? { reason: { type: 'string' } } : {}),
  } });
  if (positionals.length !== 1 || !uuid(positionals[0]) || !values.control ||
    values.reason !== undefined && !['owner-stop', 'declined', 'revoked'].includes(values.reason)) throw new Error(`Usage: fogd preview ${action} ALLOCATION_UUID --control OWNER_DIRECTORY${action === 'stop' ? ' [--reason owner-stop|declined|revoked]' : ''}`);
  const control = await readPreviewOwnerControl(values.control, positionals[0]), input = { ...control, run: previewOwnerDocker(control.dockerContext) };
  await verifyPreviewOwnerEngine(control, input.run);
  let result;
  if (action === 'stop') {
    await completePreviewStop(input, { reason: values.reason });
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
  console.log(JSON.stringify(result, null, 2));
  if (!result.runtimeObserved || result.shutdownOrdered === false) process.exitCode = 1;
}
