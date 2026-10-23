import { appName } from '@fogd/runtime/artifact';
import { isRouteRevision } from '@fogd/runtime/route-record';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const invalid = () => new Error('Controller returned invalid HTTP routing state; private response contents are withheld');
const kinds = ['initialize', 'withhold', 'active', 'withdraw', 'release-claim', 'quarantine'];
export function routeIntent(value, activeOnly = false) {
  if (typeof value !== 'string') throw invalid();
  const [kind, revision, extra] = value.split(':');
  if (extra !== undefined || !(activeOnly ? kind === 'active' : kinds.includes(kind)) || !isRouteRevision(revision)) throw invalid();
  return value;
}
export function routeSelection(deployment, digest) {
  if (!uuid(deployment) || !hash(digest)) throw invalid();
  return { deployment, digest };
}
function approval(value, key) {
  if (value === null) return null;
  return routeSelection(value?.[key], value?.digest);
}
function pendingView(value) {
  if (value === null) return null;
  if (!value || !kinds.includes(value.kind)) throw invalid();
  const intent = routeIntent(value.intent);
  if (!intent.startsWith(value.kind + ':')) throw invalid();
  return { intent, kind: value.kind, app: value.app === null ? null : appName(value.app), approval: approval(value.approval, 'id') };
}
export function routingView(value, app) {
  appName(app);
  if (value?.app !== app || !['active', 'withheld', 'unknown'].includes(value.state) || !isRouteRevision(value.revision) || typeof value.startupBlocked !== 'boolean') throw invalid();
  const active = approval(value.active, 'deployment');
  if ((value.state === 'active') !== (active !== null)) throw invalid();
  return { schema: 1, app, state: value.state, revision: value.revision, active, hold: approval(value.hold, 'id'),
    startupBlocked: value.startupBlocked, pending: pendingView(value.pending) };
}
