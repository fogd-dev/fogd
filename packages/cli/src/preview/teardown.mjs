import { isDeepStrictEqual } from 'node:util';
import { hash, jsonBytes, uuid } from '../build-cache/paths.mjs';
import { validatePreviewPlan, previewPlanTarget } from './plan.mjs';
import { previewServiceInspection } from './container-plan.mjs';
import { inspectPreviewExecution } from './execution.mjs';
import { acquirePreviewHost, guardPreviewHost, requirePreviewHold } from './host-registry.mjs';
import { validatePreviewMemoryRelease } from './memory-state.mjs';
import { previewStopGroups as groups, previewStorageRequired, previewTeardownPending, readCompletedPreviewTeardown } from './teardown-state.mjs';
import { readPreviewStopRequest, previewStopReason, previewStopRequest } from './stop-request.mjs';
import { readPreviewAllocation } from './allocation-state.mjs';
import { appendHostRecord, hostRefusal, assertRegisteredPreviewResources } from './host-records.mjs';
import { readPreviewHost } from './host-inventory.mjs';
import { assertPreviewAllocationImage, inspectPreviewGraph, previewContainerStopped } from './stopped-graph.mjs';

const byRole = (plan, observed) => Object.fromEntries(Object.entries(plan.services).map(([role, service]) => [role, observed.containers.find(value => value.Name === '/' + service.name)]));

async function target(input, { includeRetired = false } = {}) {
  const { root, plan: proposal, allocationId, reservation, envelope, expectedImage, run, ...options } = input, plan = validatePreviewPlan(proposal);
  if (!uuid(allocationId) || !uuid(reservation) || expectedImage !== plan.request.image) hostRefusal('teardown-target');
  if (!isDeepStrictEqual(Object.values(groups).flat().sort(), Object.keys(plan.services).sort())) hostRefusal('teardown-target');
  const specifications = previewServiceInspection(plan, envelope, options, allocationId);
  const grant = inspectPreviewExecution(envelope, { publicKey: options.publicKey, expectedGrantSha256: options.expectedGrantSha256, preparationSha256: plan.request.preparationSha256, target: previewPlanTarget(plan) });
  const host = await acquirePreviewHost(root, plan.request.engineId), held = await requirePreviewHold(host, plan, reservation, { includeRetired });
  const { bound, complete } = await readPreviewAllocation(host, plan, { allocationId, reservation, grantSha256: options.expectedGrantSha256, expiresAt: grant.expiresAt });
  let image;
  const observe = async phase => {
    if (!image) {
      const images = JSON.parse(await run(['image', 'inspect', expectedImage]));
      if (!Array.isArray(images) || images.length !== 1) hostRefusal('allocation-image');
      assertPreviewAllocationImage(plan, images[0], expectedImage); image = images[0];
    }
    const observed = await readPreviewHost(run); assertRegisteredPreviewResources(observed, host.records);
    const graph = inspectPreviewGraph(plan, observed, image, specifications, allocationId, complete.identities, phase);
    if (graph.inventorySha256 !== complete.inventorySha256) hostRefusal('teardown-target');
    return { observed, roles: byRole(plan, observed), graph };
  };
  return { host, held, bound, complete, plan, grant, observe, run, allocationId, reservation };
}
const stoppedRoles = roles => Object.fromEntries(Object.entries(roles).map(([role, container]) => [role, container.Id]));
// Stop only independently checked container IDs. A failed/ambiguous command or
// observation keeps the host fence and hold; storage is never stopped next.
export async function stopPreviewAllocation(input) {
  return guardPreviewHost(async () => {
    const value = await target(input, { includeRetired: true });
    const completed = await readCompletedPreviewTeardown(value.bound, value.complete);
    if (completed) { await value.observe('stopped'); await value.host.fence.release(); return completed; }
    await requirePreviewHold(value.host, value.plan, value.reservation);
    let current = await value.observe('operating');
    const needsStorage = previewStorageRequired(current.roles);
    let storageContinuous = !needsStorage || current.roles.minio.State.Running;
    const pending = previewTeardownPending(value.complete);
    await value.host.fence.record('writing'); await appendHostRecord(value.bound, 'teardown.pending.json', pending);
    for (const [name, roles] of Object.entries(groups)) {
      const ids = roles.filter(role => !previewContainerStopped(current.roles[role])).map(role => current.roles[role].Id);
      if (ids.length) await value.run(['stop', '--time', '3', ...ids]);
      current = await value.observe(name === 'storage' ? 'stopped' : 'operating');
      if (roles.some(role => !previewContainerStopped(current.roles[role]))) hostRefusal('stop-unconfirmed');
      if (name !== 'storage' && needsStorage && !current.roles.minio.State.Running) storageContinuous = false;
      await appendHostRecord(value.bound, `teardown.${name}.json`, { schema: 1, phase: name, stopped: Object.fromEntries(roles.map(role => [role, current.roles[role].Id])), storageRunning: current.roles.minio.State.Running });
    }
    const complete = { ...pending, ordered: storageContinuous, storageRequired: needsStorage, stopped: stoppedRoles(current.roles), observedAt: new Date(Date.now()).toISOString(),
      memoryBudgetHeld: true, resourcesRetained: true, namespaceReusable: false, dataDurability: 'not-assessed' };
    await appendHostRecord(value.bound, 'teardown.complete.json', complete); await value.host.fence.record('complete'); await value.host.fence.release();
    return complete;
  });
}

// Explicit memory-budget retirement only. Every resource and namespace claim is
// retained; this never establishes lease cleanup, data recovery or reusable disk.
export async function releasePreviewMemory(input) {
  return guardPreviewHost(async () => {
    const value = await target(input);
    if (Date.now() < Date.parse(value.grant.expiresAt)) { await value.host.fence.release(); hostRefusal('not-expired'); }
    const stopped = await value.observe('stopped'), complete = await readCompletedPreviewTeardown(value.bound, value.complete);
    if (!complete?.ordered || !isDeepStrictEqual(complete.stopped, stoppedRoles(stopped.roles))) hostRefusal('teardown-unconfirmed');
    const record = { schema: 1, kind: 'fogd-preview-memory-release', allocationId: value.allocationId, reservation: value.reservation,
      planSha256: value.complete.planSha256, expiresAt: value.grant.expiresAt, releasedAt: new Date(Date.now()).toISOString(),
      allocationSha256: hash(jsonBytes(value.complete)), teardownSha256: hash(jsonBytes(complete)), inventorySha256: stopped.graph.inventorySha256, namespaceReusable: false };
    await validatePreviewMemoryRelease(value.bound, value.held, record);
    await value.host.fence.record('writing'); await appendHostRecord(value.bound, 'memory.released.json', record);
    await value.host.fence.record('complete'); await value.host.fence.release();
    return { memoryBudgetReleased: true, resourcesRetained: true, namespaceReusable: false, dataDurability: 'not-assessed', executionAuthorized: false };
  });
}

async function terminationState(value) {
  const request = await readPreviewStopRequest(value.bound, value.complete), completed = await readCompletedPreviewTeardown(value.bound, value.complete);
  if (completed || request) await value.observe(completed ? 'stopped' : 'operating');
  return { allocationId: value.allocationId, request, completed, memoryBudgetHeld: value.host.heldRecords.includes(value.held) };
}

// Cheap when no intent is present: no Docker calls. Any returned stop/completion
// proof is checked against a fresh complete graph under the host fence.
export async function inspectPreviewTermination(input) {
  return guardPreviewHost(async () => {
    const value = await target(input, { includeRetired: true }), state = await terminationState(value);
    await value.host.fence.release(); return state;
  });
}

// Local-owner withdrawal only. The first durable request is immutable; this
// neither runs Docker mutations nor frees capacity, and cannot revive a preview.
export async function requestPreviewStop(input, { reason = 'owner-stop' } = {}) {
  previewStopReason(reason);
  return guardPreviewHost(async () => {
    const value = await target(input, { includeRetired: true }), state = await terminationState(value);
    if (state.completed || state.request) { await value.host.fence.release(); return state; }
    await requirePreviewHold(value.host, value.plan, value.reservation); await value.observe('operating');
    const request = previewStopRequest(value.complete, reason);
    await value.host.fence.record('writing'); await appendHostRecord(value.bound, 'stop.requested.json', request);
    await value.host.fence.record('complete'); await value.host.fence.release();
    return { ...state, request };
  });
}
