import { createHash, createHmac } from 'node:crypto';
// Diagnostic only: pinned Void live-names.ts and celld engine_api.rs namespace/id
// derivation. The fault probe must corroborate the result with runtime residency.
export function namedCell(script, className, name) {
  const namespace=`cells:v1:${Buffer.byteLength(script)}:${script}:${className}`;
  const key=createHash('sha256').update(namespace).digest();
  const first=createHmac('sha256',key).update(name).digest().subarray(0,16);
  const last=createHmac('sha256',key).update(first).digest().subarray(0,16);
  return `${className}:${Buffer.concat([first,last]).toString('hex')}`;
}

export function liveTopicCell(script, room) {
  const topic=createHash('sha256').update(`checklist-hints\0${room}`).digest('base64url');
  return namedCell(script,'VoidLiveStreamDurableObject',`live:checklist-hints:topic:${topic}`);
}
export function liveConnectionCell(script, connectionId) {
  return namedCell(script,'VoidLiveStreamDurableObject',`live:checklist-hints:connection:${connectionId}`);
}
