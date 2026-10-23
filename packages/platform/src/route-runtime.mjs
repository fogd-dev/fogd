import { isDeepStrictEqual } from 'node:util';
import { completedRoute } from './route-publication.mjs';
import { backendRuntimeIdentity } from './backend-runtime-identity.mjs';
import { validateRuntimePolicy } from './runtime-policy.mjs';

const refused = () => Object.assign(new Error('Approved HTTP runtime could not be verified'), { code: 'ROUTE_RUNTIME_UNCONFIRMED' });
const cancel = body => { if (body) void body.cancel().catch(() => {}); };
async function boundedJSON(response, signal) {
  const reader = response.body.getReader(), chunks = []; let bytes = 0, done = false;
  const abort = () => cancel(reader); signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (!done) {
      const part = await reader.read(); done = part.done; signal.throwIfAborted();
      if (done) break;
      bytes += part.value.byteLength;
      if (bytes > 4 * 1024 ** 2) throw refused();
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal.removeEventListener('abort', abort); if (!done) cancel(reader); reader.releaseLock();
  }
}
async function inspect(request, url, json) {
  const controller = new AbortController(); let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(refused()); }, 3000);
  });
  const read = async () => {
    const response = await request(url, { method: 'GET', redirect: 'error', signal: controller.signal });
    if (controller.signal.aborted || response.status !== 200) { cancel(response.body); throw refused(); }
    if (!json) { cancel(response.body); return; }
    return boundedJSON(response, controller.signal);
  };
  try { return await Promise.race([read(), deadline]); }
  finally { clearTimeout(timer); }
}
function selection(controller, name, selected) {
  const route = completedRoute(controller.state, name, controller.baseDomain);
  const app = controller.state.apps[name], release = controller.state.deployments[selected?.id];
  if (route.submission !== selected?.id || route.digest !== selected?.digest || app.quarantined || app.uncertain || app.claim ||
    typeof release?.version !== 'string' || !release.version || release.version.length > 512) throw refused();
  const slots = controller.slots.filter(slot => slot.id === route.slot);
  if (slots.length !== 1 || slots[0].nodes.length !== 2) throw refused();
  return structuredClone({ slot: slots[0], version: release.version, route, secretRevision: release.secretRevision });
}
async function replicas(request, slot, version) {
  for (const node of slot.nodes) {
    const url = `http://${node}`;
    const before = await inspect(request, url + ':8081/state', true);
    if (before?.deployment?.version !== version) throw refused();
    await inspect(request, url + ':8080/.well-known/celld/health', false);
    const after = await inspect(request, url + ':8081/state', true);
    if (after?.deployment?.version !== version) throw refused();
  }
}
// Run under controller serialization, with topology preventing other live writers.
// This observes a bounded interval; it is not a fence against later process loss.
export function routeRuntimeVerifier(controller, identity, { request = fetch } = {}) {
  return async (name, selected) => {
    try {
      const expected = selection(controller, name, selected), backend = controller.backend;
      if ((await backend.owner(expected.slot))?.app !== name) throw refused();
      const before = await identity.verify(expected.slot);
      if (typeof before !== 'string' || !/^[a-f0-9]{64}$/.test(before)) throw refused();
      await replicas(request, expected.slot, expected.version);
      const after = await identity.verify(expected.slot);
      if (before !== after || (await backend.owner(expected.slot))?.app !== name || !isDeepStrictEqual(expected, selection(controller, name, selected))) throw refused();
    } catch { throw refused(); }
  };
}
export function backendRouteVerifier(controller, profile) {
  const expected = validateRuntimePolicy(profile, controller.backend.env);
  return routeRuntimeVerifier(controller, backendRuntimeIdentity(controller.backend, expected));
}
