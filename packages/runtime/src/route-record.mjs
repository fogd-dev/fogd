const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const slot = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,62}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const invalid = () => { throw new Error('Invalid route authority record'); };
const encoder = new TextEncoder();
export const maxRouteRecordBytes = 65536;
export const routeRecordFilename = 'routes.json';

export function validateRoutePolicy(policy) {
  if (!exactKeys(policy, ['installation', 'slots']) || !digest(policy.installation) || !Array.isArray(policy.slots) || !policy.slots.length || policy.slots.length > 3 || !policy.slots.every(slot) || new Set(policy.slots).size !== policy.slots.length) throw new Error('Invalid route authority policy');
  return policy;
}
export const isRouteRevision = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
function hostname(value) {
  if (typeof value !== 'string' || value.length > 253 || !value.includes('.') || !value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  try { return new URL('http://' + value).hostname === value; } catch { return false; }
}
function recordEnvelope(value, policy) {
  if (!exactKeys(value, ['schema', 'installation', 'revision', 'routes']) || value.schema !== 1 || value.installation !== policy.installation ||
    !isRouteRevision(value.revision) || !Array.isArray(value.routes) || value.routes.length > policy.slots.length || (value.revision === '0' && value.routes.length)) return invalid();
}

function routeEntry(value, slots) {
  if (!value || !hostname(value.host) || !slots.includes(value.slot)) return invalid();
  if (value.state === 'withheld' && exactKeys(value, ['host', 'state', 'slot'])) return { host: value.host, state: value.state, slot: value.slot };
  if (value.state !== 'active' || !exactKeys(value, ['host', 'state', 'slot', 'submission', 'digest']) ||
    typeof value.submission !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.submission) || !digest(value.digest)) return invalid();
  return { host: value.host, state: value.state, slot: value.slot, submission: value.submission, digest: value.digest };
}
export function decodeRouteRecord(text, inputPolicy) {
  const policy = validateRoutePolicy(inputPolicy);
  if (typeof text !== 'string' || text.length > maxRouteRecordBytes || encoder.encode(text).byteLength > maxRouteRecordBytes) return invalid();
  let value;
  try { value = JSON.parse(text); } catch { return invalid(); }
  recordEnvelope(value, policy);
  const routes = value.routes.map(route => routeEntry(route, policy.slots));
  if (new Set(routes.map(route => route.slot)).size !== routes.length || routes.some((route, index) => index && routes[index - 1].host >= route.host)) return invalid();
  return { schema: 1, installation: value.installation, revision: value.revision, routes };
}
export function encodeRouteRecord(record, policy) {
  let text;
  try { text = JSON.stringify(record); } catch { return invalid(); }
  return JSON.stringify(decodeRouteRecord(text, policy), null, 2);
}
