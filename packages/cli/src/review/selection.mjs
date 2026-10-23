import { applicationInspection } from '../inspection.mjs';
import { submitterStatus } from '../submitter-status.mjs';
import { uuid } from '../build-cache/paths.mjs';

export function reviewSelection(state, id) {
  const request = state?.deployments?.[id];
  if (!request) throw new Error('Submission is unavailable; check its ID and the selected controller');
  const release = submitterStatus(request, id);
  const inspection = applicationInspection(state, release.app);
  const active = inspection.active;
  const submitter = submitterView(state.credentials, request.submitter);
  if (request.secretRevision != null && !uuid(request.secretRevision)) throw new Error('Controller returned an invalid pinned secret revision');
  const context = { routing: inspection.routing, quarantined: inspection.quarantined, retired: inspection.retired,
    ownershipClaim: inspection.ownershipClaim, uncertainMigration: inspection.uncertainMigration, background: inspection.controls, nextChecks: inspection.nextChecks };
  return { view: { app: release.app, proposed: { id, digest: release.digest, status: release.status, submittedAt: release.submittedAt, submitter,
    pinnedSecretRevision: request.secretRevision || null }, active, context },
  // Private diagnostics and versions participate in the stability check only.
  // They must never be spread into the exported review.
  guard: { request, app: state.apps[release.app] || null, active: active ? state.deployments[active.id] : null, submitter } };
}

function submitterView(credentials, id) {
  if (id === 'team-token') return { id, name: 'Legacy team credential', revoked: null };
  if (!uuid(id) || !Array.isArray(credentials)) throw new Error('Controller returned an invalid submission credential reference');
  const matches = credentials.filter(credential => credential?.id === id);
  if (matches.length > 1) throw new Error('Controller returned an ambiguous submission credential');
  const record = matches[0];
  if (record && (typeof record.name !== 'string' || record.name.length > 120 || /[\x00-\x1f\x7f]/.test(record.name))) throw new Error('Controller returned an invalid credential label');
  return { id, name: record?.name ?? null, revoked: record ? Boolean(record.revokedAt) : null };
}
