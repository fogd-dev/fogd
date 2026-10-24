import { decodeRouteRecord, validateRoutePolicy, maxRouteRecordBytes, routeRecordFilename } from './route-record.mjs';

// Cancellation must not extend a request's deadline when a producer is stuck.
const cancel = reader => { void reader.cancel().catch(() => {}); };
async function boundedBody(response, signal) {
  if (signal.aborted) { if (response.body) cancel(response.body); throw new Error('Authority read expired'); }
  const reader = response.body.getReader(), chunks = []; let bytes = 0, done = false;
  const abort = () => cancel(reader);
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (!done) {
      const next = await reader.read(); done = next.done;
      signal.throwIfAborted();
      if (done) break;
      if (!(next.value instanceof Uint8Array) || bytes + next.value.byteLength > maxRouteRecordBytes) throw new Error('Invalid authority body');
      chunks.push(next.value); bytes += next.value.byteLength;
    }
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } finally {
    signal.removeEventListener('abort', abort);
    if (!done) cancel(reader);
    reader.releaseLock();
  }
}
async function readRecord(env, policy, signal) {
  // This header is not freshness evidence; native disk reads require qualification.
  const response = await env.ROUTE_AUTHORITY.fetch('http://authority/' + routeRecordFilename, {
    method: 'GET', headers: { 'Cache-Control': 'no-store' }, redirect: 'manual', signal,
  });
  if (response.status !== 200) { if (response.body) cancel(response.body); throw new Error('Authority unavailable'); }
  return decodeRouteRecord(await boundedBody(response, signal), policy);
}
export async function gatewayAuthority(env) {
  const policy = validateRoutePolicy(JSON.parse(env.ROUTE_POLICY));
  const controller = new AbortController(); let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Authority read expired')); }, 3000);
  });
  try { return await Promise.race([readRecord(env, policy, controller.signal), deadline]); }
  finally { clearTimeout(timer); }
}
