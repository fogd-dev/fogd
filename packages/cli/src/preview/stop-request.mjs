import { isDeepStrictEqual } from 'node:util';
import { optionalPreviewRecord, previewTeardownPending } from './teardown-state.mjs';
import { hostRefusal, previewRecordTime } from './host-records.mjs';

const reasons = ['owner-stop', 'declined', 'revoked', 'source-unverifiable', 'cancelled', 'expiry'];
export function previewStopReason(reason) { if (!reasons.includes(reason)) hostRefusal('stop-reason'); return reason; }

export function previewStopRequest(allocation, reason, requestedAt = new Date(Date.now()).toISOString()) {
  return { ...previewTeardownPending(allocation), kind: 'fogd-preview-stop-request', reason: previewStopReason(reason), requestedAt, authority: 'local-preview-owner' };
}

export async function readPreviewStopRequest(bound, allocation) {
  const value = await optionalPreviewRecord(bound, 'stop.requested.json');
  if (!value) return null;
  if (!previewRecordTime(value.requestedAt) || !isDeepStrictEqual(value, previewStopRequest(allocation, value.reason, value.requestedAt))) hostRefusal('stop-request-state');
  return value;
}
