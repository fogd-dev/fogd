import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { runtimePolicyIdentity, validateRuntimePolicy } from '@fogd/platform/runtime-policy';
import { encodeRouteRecord } from '@fogd/runtime/route-record';
import { serverOrigin } from '../local.mjs';

const TIMEOUT_MS = 30000, ADMIN_MAX_BYTES = 4 * 1024 * 1024, REPORT_MAX_BYTES = 256 * 1024;
const refused = () => Object.assign(new Error('HTTP routing preflight is unconfirmed; keep ingress stopped'), { code: 'ROUTE_PREFLIGHT_UNCONFIRMED' });
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());

function durablePolicy(profile) {
  let policy;
  try { policy = validateRuntimePolicy(profile); } catch { policy = null; }
  if (policy?.schema !== 3 || policy.routing !== 'durable') {
    throw Object.assign(new Error('Routing preflight requires an independently selected durable runtime profile'), { code: 'ROUTE_PREFLIGHT_PROFILE' });
  }
  return { installation: runtimePolicyIdentity(policy), slots: policy.fleets.map(fleet => fleet.id) };
}

// Reads the whole body under the operation deadline; byte bound and UTF-8 are strict.
async function readJson(response, limit, signal) {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (response.status !== 200 || type !== 'application/json' || !response.body) throw refused();
  const reader = response.body.getReader(), chunks = [];
  const abort = () => reader.cancel().catch(() => {});
  signal.addEventListener('abort', abort, { once: true });
  try {
    let bytes = 0;
    for (;;) {
      if (signal.aborted) throw refused();
      const { done, value } = await reader.read();
      if (signal.aborted) throw refused();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw refused();
      bytes += value.byteLength;
      if (bytes > limit) throw refused();
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal.removeEventListener('abort', abort);
    reader.cancel().catch(() => {});
  }
}

function observation(report, challenge, policy) {
  if (!exactKeys(report, ['schema', 'challenge', 'authority', 'observedActiveHosts']) || report.schema !== 1 || report.challenge !== challenge ||
    !exactKeys(report.authority, ['record', 'sha256']) || typeof report.authority.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(report.authority.sha256) ||
    !Array.isArray(report.observedActiveHosts)) throw refused();
  // Publication writes canonical encodeRouteRecord bytes, so the digest must match them exactly.
  const canonical = encodeRouteRecord(report.authority.record, policy), record = JSON.parse(canonical);
  if (createHash('sha256').update(canonical).digest('hex') !== report.authority.sha256) throw refused();
  const active = record.routes.filter(route => route.state === 'active').map(route => route.host);
  if (!isDeepStrictEqual(report.observedActiveHosts, active)) throw refused();
  return { schema: 1, challenge, authority: { record, sha256: report.authority.sha256 }, observedActiveHosts: active };
}

// The result is an observation interval only: never an authorization lease or mount proof.
export async function requestRoutingPreflight(env, profile, { fetchImpl = fetch } = {}) {
  const policy = durablePolicy(profile);
  if (!env || typeof env.FOGD_ADMIN_PASSWORD !== 'string' || !env.FOGD_ADMIN_PASSWORD) throw refused();
  const challenge = randomBytes(32).toString('hex');
  const authorization = `Basic ${Buffer.from(`${env.FOGD_ADMIN_USER || 'admin'}:${env.FOGD_ADMIN_PASSWORD}`).toString('base64')}`;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const { signal } = controller;
  try {
    const origin = serverOrigin(env);
    const admin = await readJson(await fetchImpl(`${origin}/v1/admin`, { headers: { Authorization: authorization }, redirect: 'error', signal }), ADMIN_MAX_BYTES, signal);
    if (!admin || typeof admin !== 'object' || Object.hasOwn(admin, 'recoveryOnly') || typeof admin.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(admin.csrf)) throw refused();
    const response = await fetchImpl(`${origin}/v1/admin/routing/preflight`, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: authorization, 'Content-Type': 'application/json', 'X-Fogd-CSRF': admin.csrf },
      body: JSON.stringify({ challenge }),
    });
    return observation(await readJson(response, REPORT_MAX_BYTES, signal), challenge, policy);
  } catch { throw refused(); } finally { clearTimeout(timer); controller.abort(); }
}
