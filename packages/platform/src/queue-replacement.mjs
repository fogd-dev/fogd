import { isDeepStrictEqual } from 'node:util';
import { artifactDigest } from '@fogd/runtime/artifact';
import { deliveryFor, prepareQueue } from './queue-activation.mjs';

// Validate operator intent before any runtime operation. A retry may repeat the
// original replacement tuple, but cannot silently select a different predecessor.
export function replacementFor(controller, request, replaces) {
  if (replaces === undefined) return null;
  validateReplacementInput(replaces);
  const app = controller.state.apps[request.app];
  if (!app?.delivery?.hold) throw new Error('Replacement requires an activation hold');
  if (request.replaces && !isDeepStrictEqual(request.replaces, replaces)) throw new Error('Replacement predecessor changed; submit a new deployment request');
  if (app.delivery.hold === request.id && isDeepStrictEqual(request.replaces, replaces)) return null;
  const previous = controller.state.deployments[app.delivery.hold];
  assertHeldRequest(previous, request, replaces);
  if (previous.id === request.id) throw new Error('A deployment cannot replace itself');
  if (app.uncertain && app.uncertain !== previous.id) throw new Error('Held activation does not own the uncertain migration attempt');
  return previous;
}

function validateReplacementInput(replaces) {
  if (!replaces || Object.keys(replaces).length !== 2 || typeof replaces.deployment !== 'string' || !/^[a-f0-9]{64}$/.test(replaces.digest || '')) throw new Error('Replacement requires the held deployment ID and digest');
}

function assertHeldRequest(previous, request, replaces) {
  if (!previous || previous.id !== replaces.deployment || previous.digest !== replaces.digest || previous.app !== request.app || previous.status !== 'failed') throw new Error('Held deployment/digest changed or is not a failed activation');
}

export async function replaceQueueApproval(controller, request, previous, app, slot, selected) {
  const original = structuredClone(request), originalRoute = app.route, originalPrivacy = app.privateConfiguration;
  try {
    if (await artifactDigest(controller.artifact(previous.id)) !== previous.digest) throw new Error('Original held artifact digest mismatch');
    // Preflight operates under the old approval. It cannot publish candidate code
    // or overwrite the original uncertain migration pointer.
    const step = () => controller.save();
    await prepareQueue(controller, previous, app, slot, controller.artifact(previous.id), step);
    await controller.reconcile(app, slot);
    controller.compatible(request, app);
    if (await artifactDigest(controller.artifact(request.id)) !== request.digest) throw new Error('Replacement artifact digest mismatch');
    await transfer(controller, request, previous, app, slot, selected);
  } catch (cause) {
    controller.assertStorage();
    const message = app.privateConfiguration || selected.revision ? 'Private replacement preparation failed; diagnostics are withheld' : cause.message;
    if (app.delivery.hold === request.id) {
      request.status = 'failed'; request.error = message; await controller.save();
    } else {
      for (const key of Object.keys(request)) delete request[key];
      Object.assign(request, original); app.route = originalRoute;
      if (originalPrivacy === undefined) delete app.privateConfiguration;
      else app.privateConfiguration = originalPrivacy;
    }
    throw new Error(message, { cause });
  }
}

async function transfer(controller, request, previous, app, slot, selected) {
  request.secretRevision = selected.revision;
  request.replaces = { deployment: previous.id, digest: previous.digest };
  request.status = 'activating'; request.step = 'transferring-delivery-hold'; request.error = null;
  app.route = 'paused'; app.privateConfiguration ||= Boolean(selected.revision);
  // Delivery's intent write saves this approval and its new hold in ONE state
  // file, before the idempotent pause command. Operator intent/version survive.
  await deliveryFor(controller, app, slot).hold(request.id, { replaces: previous.id });
}
