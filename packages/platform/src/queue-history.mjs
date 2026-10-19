import { isDeepStrictEqual } from 'node:util';
import { translateQueues } from '@fogd/runtime/queues';

// A submission has no runtime authority. Approval pins secretRevision and changes
// step before the first ownership effect; rejection alone cannot erase that fact.
export function artifactOnlyQueueRequest(state, request) {
  if (!state.requirements?.includes('fogd-queue-activation-v1') || !validIdentity(state, request) || referencedApproval(state, request.id)) return false;
  try { if (!isDeepStrictEqual(translateQueues(request.resources.queues, request.app), request.resources.queues)) return false; } catch { return false; }
  if (!['pending', 'rejected', 'superseded'].includes(request.status)) return false;
  if (request.step === 'submitted' && !Object.hasOwn(request, 'secretRevision')) return !Object.hasOwn(request, 'claimRelease');
  return validClaimRelease(state, request);
}
function validClaimRelease(state, request) {
  const receipt = request.claimRelease;
  if (request.status !== 'rejected' || request.step !== 'preparing-activation' || !Object.hasOwn(request, 'secretRevision') || !state.requirements?.includes('fogd-claim-intent-v1')) return false;
  if (!receipt || receipt.schema !== 1 || receipt.deployment !== request.id || receipt.digest !== request.digest || !/^[a-f0-9]{64}$/.test(receipt.digest)) return false;
  return typeof receipt.slot === 'string' && Boolean(receipt.slot) && typeof receipt.prefix === 'string' && Boolean(receipt.prefix) && typeof receipt.at === 'string' && Number.isFinite(Date.parse(receipt.at));
}

function validIdentity(state, request) {
  return request?.resources?.queues && typeof request.app === 'string' && request.resources.script === request.app && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(request.id || '') && /^[a-f0-9]{64}$/.test(request.digest || '') && state.deployments[request.id] === request;
}

export function hasQueueLifecycle(app) {
  return Boolean(app.resources && Object.hasOwn(app.resources, 'queues')) ||
    ['delivery', 'queueBootstrap', 'queueSnapshot', 'queueRecovery', 'deliveryRecoveryError'].some(field => Object.hasOwn(app, field)) || Boolean(app.retirement?.queue);
}

function referencedApproval(state, id) {
  return Object.values(state.apps).some(app => [app.active, app.uncertain, app.claim?.deployment, app.delivery?.hold, app.queueSnapshot?.deployment, app.queueRecovery?.prepared?.deployment].includes(id));
}
