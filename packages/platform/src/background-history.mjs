// Before approval, an artifact has no runtime authority. A rejected approval is
// artifact-only again only when its original claim was durably released.
export function artifactOnlyBackgroundRequest(state, request, capability, validateResources) {
  if (!state.requirements?.includes(capability) || !validIdentity(state, request) || referencedApproval(state, request.id)) return false;
  try { if (!validateResources(request.resources, request.app)) return false; } catch { return false; }
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
  return typeof request?.app === 'string' && request.resources?.script === request.app && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(request.id || '') && /^[a-f0-9]{64}$/.test(request.digest || '') && state.deployments[request.id] === request;
}
function referencedApproval(state, id) {
  return Object.values(state.apps).some(app => [app.active, app.uncertain, app.claim?.deployment,
    app.delivery?.hold, app.queueSnapshot?.deployment, app.queueRecovery?.prepared?.deployment,
    app.dispatch?.hold, app.cronSnapshot?.deployment, app.cronRecovery?.prepared?.deployment].includes(id));
}
