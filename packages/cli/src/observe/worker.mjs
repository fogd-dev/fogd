// Runs in the independently verified image. No app routes, reload, SQL, queue/cron
// observation, diagnosis write probes or process logs are requested.
import { createHash } from 'node:crypto';

export async function observeFleet({ identity, request = fetch, profile, slot, expected, now = Date.now }) {
  const before = await membership(identity, profile, slot, now);
  const replicas = await Promise.all(slot.nodes.map(node => observeReplica(request, node, expected)));
  let verified = false;
  try { await identity.verify(slot); verified = true; } catch { /* Private proof diagnostics stay inside the helper. */ }
  const after = await membership(identity, profile, slot, now), leases = leaseState(before, after);
  return { identity: verified && leases === 'current' ? 'verified' : 'unconfirmed', leases, replicas };
}
function leaseState(before, after) {
  if (!before || !after || before.key !== after.key || before.current !== after.current) return 'unconfirmed';
  return before.current ? 'current' : 'expired';
}
async function membership(identity, profile, slot, now) {
  try {
    const members = await identity.members(slot), at = now(), fleet = profile.fleets.find(value => value.id === slot.id);
    if (!Number.isSafeInteger(at) || at < 0) return null;
    if (members.length !== slot.nodes.length || new Set(members.map(row => row.node)).size !== members.length) return null;
    if (!members.every(member => validMember(member, fleet))) return null;
    const values = members.map(({ node, processKey }) => [node, processKey]).sort((a, b) => a[0].localeCompare(b[0]));
    return { key: createHash('sha256').update(JSON.stringify(values)).digest('hex'), current: members.every(member => member.expiresMs > at) };
  } catch { return null; }
}
function validMember(member, fleet) {
  const node = fleet.nodes.find(value => value.id === member.node);
  return Boolean(node && member.key === `${node.id}.json` && member.addr === `${node.host}:8081` && typeof member.processKey === 'string' && /^[a-f0-9]{64}$/.test(member.processKey) && Number.isSafeInteger(member.expiresMs) && member.expiresMs >= 0);
}
async function observeReplica(request, node, expected) {
  const [state, health] = await Promise.all([get(request, `http://${node}:8081/state`, true), get(request, `http://${node}:8080/.well-known/celld/health`, false)]);
  return { node, stateHTTPStatus: state.status, healthHTTPStatus: health.status,
    version: typeof state.value?.deployment?.version === 'string' ? (state.value.deployment.version === expected.version ? 'matches' : 'differs') : 'unknown' };
}
async function get(request, url, json) {
  try {
    const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!json || !response.ok) { await response.body?.cancel(); return { status: response.status }; }
    const chunks = []; let bytes = 0;
    for await (const part of response.body) { bytes += part.length; if (bytes > 4 * 1024 ** 2) throw new Error('Native state is oversized'); chunks.push(part); }
    return { status: response.status, value: JSON.parse(Buffer.concat(chunks)) };
  } catch { return { status: null }; }
}

export async function main() {
  let text = '';
  for await (const part of process.stdin) { text += part; if (Buffer.byteLength(text) > 131072) throw new Error('Observation input is oversized'); }
  const { env, profile, expected } = JSON.parse(text);
  const [{ Backend }, { validateRuntimePolicy }, { backendRuntimeIdentity }] = await Promise.all([
    import('/app/packages/platform/src/backend.mjs'), import('/app/packages/platform/src/runtime-policy.mjs'), import('/app/packages/platform/src/backend-runtime-identity.mjs'),
  ]);
  const validated = validateRuntimePolicy(profile, env), backend = new Backend(env), identity = backendRuntimeIdentity(backend, validated);
  const slot = JSON.parse(env.FOGD_SLOTS).find(value => value.id === expected.slot);
  if (!slot) throw new Error('Observation fleet is absent');
  console.log(JSON.stringify(await observeFleet({ identity, profile: validated, slot, expected })));
}
