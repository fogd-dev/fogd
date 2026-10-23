import { decodeRouteRecord } from '@fogd/runtime/route-record';
import { routeRecordDigest } from './route-record-store.mjs';
import { routeAuthorityJournal } from './route-publication.mjs';

function settledRecord(state, observed, policy) {
  const journal = routeAuthorityJournal(state, policy);
  const record = decodeRouteRecord(JSON.stringify(observed.record), policy);
  if (journal.pending || journal.settled?.revision !== record.revision || journal.settled.digest !== observed.digest || routeRecordDigest(record, policy) !== observed.digest) throw new Error('Retirement requires settled matching route authority');
  return { journal, record };
}
function retiredApplication(state, app) {
  const retired = state.apps?.[app], deployment = state.deployments?.[retired?.active];
  if (!retired?.retirement || retired.slot !== null || retired.route !== 'retired' || deployment?.app !== app || deployment.status !== 'retired' ||
    retired.retirement.deployment !== retired.active || retired.retirement.digest !== deployment.digest) throw new Error('Route removal requires the exact retired application');
  return { retired, deployment };
}

// Pure data transform for the stopped-writers CLI. This performs no live write
// and grants no permission to bypass the existing retirement/restore guards.
export function retireRouteAuthority(state, observed, { app, domain, sourcePolicy, targetPolicy }) {
  const { journal, record: original } = settledRecord(state, observed, sourcePolicy);
  const { retired, deployment } = retiredApplication(state, app);
  const host = `${app}.${domain}`, entry = original.routes.find(value => value.host === host);
  if (!entry || (entry.slot !== retired.retirement.previous.slot || (entry.state === 'active' && (entry.submission !== retired.active || entry.digest !== deployment.digest)))) throw new Error('Retired route differs from its approval and slot');
  const record = { schema: 1, installation: targetPolicy.installation, revision: String(BigInt(original.revision) + 1n), routes: original.routes.filter(value => value.host !== host) };
  const digest = routeRecordDigest(record, targetPolicy), next = structuredClone(state), holds = { ...journal.holds };
  delete holds[app];
  next.routeAuthority = { schema: 1, installation: targetPolicy.installation, holds, settled: { revision: record.revision, digest }, pending: null };
  return { state: next, record };
}
