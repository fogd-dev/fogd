import { verifyReviewedDecision } from './review-artifact.mjs';
import { appName } from '@fogd/runtime/artifact';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';

const reviewKeys = new WeakMap();

export const decisionHistoryCapability = 'fogd-decision-history-v1';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const outcomes = ['started', 'succeeded', 'activation-failed', 'refused', 'unconfirmed'];
const statuses = ['pending', 'failed', 'active', 'rejected', 'superseded', 'activating', 'retired'];
const fields = ['id', 'at', 'actor', 'deployment', 'app', 'digest', 'action', 'secretRevision', 'review', 'outcome', 'completedAt', 'applicationStatus'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function actor(value) {
  return exact(value, ['kind', 'name']) && value.kind === 'basic' && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 256 && !/[\x00-\x1f\x7f]/.test(value.name);
}

export function decisionReviewToken(controller, id) {
  const request = controller.state.deployments[id];
  if (!request) throw new Error('Deployment/digest mismatch');
  const app = controller.state.apps[request.app] || null;
  const revision = selectedSecretRevision(controller, request);
  if (!reviewKeys.has(controller)) reviewKeys.set(controller, randomBytes(32));
  return createHmac('sha256', reviewKeys.get(controller)).update(JSON.stringify({ request, app, active: controller.state.deployments[app?.active] || null, revision })).digest('hex');
}

export function selectedSecretRevision(controller, request) {
  return (request.requiredSecrets || []).length ? request.secretRevision || controller.secrets.index[request.app]?.revision || null : null;
}

export function validateDecisionHistory(state) {
  if (state.decisions === undefined) {
    if (state.requirements?.includes(decisionHistoryCapability)) throw new Error('Decision history is missing; restore matching metadata');
    return;
  }
  if (!Array.isArray(state.decisions) || !state.requirements?.includes(decisionHistoryCapability)) throw new Error('Invalid decision history capability');
  const seen = new Set();
  for (const entry of state.decisions) {
    if (!validEntry(entry) || seen.has(entry.id)) throw new Error('Invalid decision history; restore matching metadata');
    const request = state.deployments[entry.deployment];
    if (!request || request.app !== entry.app || request.digest !== entry.digest) throw new Error('Decision history differs from deployment identity');
    seen.add(entry.id);
  }
}
const nullable = (value, validate) => value === null || validate(value);
function validEntry(entry) {
  if (!exact(entry, fields)) return false;
  return [uuid(entry.id), uuid(entry.deployment), date(entry.at), validApp(entry.app), actor(entry.actor), digest(entry.digest),
    ['approve', 'reject'].includes(entry.action), outcomes.includes(entry.outcome), statuses.includes(entry.applicationStatus),
    nullable(entry.secretRevision, uuid), nullable(entry.review, digest), validCompletion(entry)].every(Boolean);
}
function validApp(value) {
  try { appName(value); return true; } catch { return false; }
}
function validCompletion(entry) {
  return entry.completedAt === null ? ['started', 'unconfirmed'].includes(entry.outcome) : date(entry.completedAt) && entry.outcome !== 'started';
}
export function recoverDecisionHistory(state) {
  validateDecisionHistory(state);
  for (const entry of state.decisions || []) if (entry.outcome === 'started') entry.outcome = 'unconfirmed';
}

function begin(controller, id, expectedDigest, action, secretRevision, context) {
  const request = decisionRequest(controller.state, id, expectedDigest);
  validateContext(id, expectedDigest, action, secretRevision ?? null, context);
  validateDecisionHistory(controller.state);
  const entry = { id: randomUUID(), at: new Date().toISOString(), actor: { ...context.actor }, deployment: id, app: request.app,
    digest: expectedDigest, action, secretRevision: secretRevision ?? null, review: context.review ?? null,
    outcome: 'started', completedAt: null, applicationStatus: request.status };
  if (!validEntry(entry)) throw new Error('Invalid decision identity or checkpoint');
  controller.state.requirements = [...new Set([...(controller.state.requirements || []), decisionHistoryCapability])];
  (controller.state.decisions ||= []).push(entry);
  return entry;
}

function decisionRequest(state, id, digest) {
  const request = state.deployments[id];
  if (!request || request.digest !== digest) throw new Error('Deployment/digest mismatch');
  return request;
}
function validateContext(id, expectedDigest, action, secretRevision, context) {
  if (![uuid(id), digest(expectedDigest), ['approve', 'reject'].includes(action), actor(context.actor)].every(Boolean)) throw new Error('Invalid authenticated decision');
  if (!nullable(secretRevision, uuid) || !nullable(context.review ?? null, digest)) throw new Error('Invalid decision revision or review');
}

// The controller holds its exclusive mutation lock for this entire operation.
// Durable intent precedes effects; a failed write latches the existing storage fence.
export async function authenticatedDecision(controller, id, digest, action, secretRevision, context, perform) {
  const entry = begin(controller, id, digest, action, secretRevision, context);
  await controller.save();
  let effectsStarted = false;
  try {
    if (entry.review && (entry.review !== decisionReviewToken(controller, id) || entry.secretRevision !== selectedSecretRevision(controller, controller.state.deployments[id]))) {
      const error = new Error('Review context changed; reload the exact submission before deciding'); error.code = 'DECISION_REVIEW_STALE'; throw error;
    }
    if (entry.review) await verifyReviewedDecision(controller, id);
    const result = await perform(() => { effectsStarted = true; }, entry);
    entry.outcome = result.status === 'failed' ? 'activation-failed' : 'succeeded';
    entry.applicationStatus = result.status; entry.completedAt = new Date().toISOString();
    await controller.save();
    return result;
  } catch (error) {
    controller.assertStorage();
    entry.outcome = effectsStarted ? 'unconfirmed' : 'refused';
    entry.applicationStatus = controller.state.deployments[id].status;
    entry.completedAt = new Date().toISOString();
    await controller.save();
    throw error;
  }
}

export function decisionHistory(controller, { app, before, limit = 100 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || before !== undefined && !uuid(before)) throw new Error('Invalid decision history selection');
  const entries = controller.state.decisions || [];
  const boundary = before === undefined ? entries.length : entries.findIndex(entry => entry.id === before);
  if (boundary < 0) throw new Error('Decision history cursor is unavailable');
  const selected = entries.slice(0, boundary).filter(entry => app === undefined || entry.app === app).reverse();
  return { schema: 1, entries: structuredClone(selected.slice(0, limit)), next: selected.length > limit ? selected[limit - 1].id : null,
    principalNotice: 'Basic administrator names identify credentials. Shared credentials do not identify distinct people.',
    outcomeNotice: 'Unconfirmed decisions require inspection of the recorded application state; they are never replayed automatically.' };
}
