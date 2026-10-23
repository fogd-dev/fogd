import { quarantineReason, recoveryReasons, controlRecoveryError } from './inspection-reasons.mjs';
import { validateArtifactPruningSummary } from '@fogd/platform/artifact-prune-state';
const statuses = ['pending', 'activating', 'active', 'failed', 'rejected', 'superseded', 'retired'];
const steps = ['submitted', 'approved', 'preparing-activation', 'publishing', 'waiting-for-replicas', 'validating-application', 'checking-migration-ledger', 'migrating', 'complete',
  'queue-bootstrap-intent', 'publishing-queue-bootstrap', 'waiting-for-queue-bootstrap', 'pausing-delivery', 'queue-application-intent', 'releasing-delivery', 'transferring-delivery-hold',
  'cron-bootstrap-intent', 'publishing-cron-bootstrap', 'waiting-for-cron-bootstrap', 'pausing-dispatch', 'cron-application-intent', 'releasing-dispatch'];
const choice = (value, allowed, fallback = 'unknown') => allowed.includes(value) ? value : fallback;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function applicationInspection(state, name) {
  if (!object(state?.apps) || !object(state?.deployments)) throw new Error('Controller returned unsupported application state');
  const pruning = validateArtifactPruningSummary(state);
  const hasApp = Object.hasOwn(state.apps, name), app = hasApp ? state.apps[name] : null;
  if (hasApp && !object(app)) throw new Error('Controller returned unsupported application state');
  const entries = Object.entries(state.deployments).filter(([, value]) => value?.app === name);
  const releases = entries.map(([, value]) => releaseView(value)).sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || '') || a.id.localeCompare(b.id));
  if (new Set(releases.map(value => value.id)).size !== releases.length) throw new Error('Controller returned ambiguous deployment references');
  if (entries.some(([key, value]) => key !== value.id)) throw new Error('Controller returned inconsistent deployment keys; inspect controller consistency');
  if (!app && !releases.length) throw new Error('No recorded application or submissions found for this app');
  const controls = {};
  for (const [surface, journal, recovery] of [['delivery', app?.delivery, app?.queueRecovery], ['dispatch', app?.dispatch, app?.cronRecovery]]) {
    if (journal) controls[surface] = controlView(surface, journal, recovery, releases, app[`${surface}RecoveryError`]);
  }
  const report = { schema: 1, app: name, source: 'controller-recorded', runtimeHealth: 'not-observed', applicationOutcomes: 'not-observed',
    routing: app ? choice(app.route, ['active', 'paused', 'retired']) : 'unassigned',
    retired: Boolean(app?.retirement), quarantined: Boolean(app?.quarantined), quarantineReason: quarantineReason(app), ownershipClaim: claimReference(app?.claim, releases), uncertainMigration: statusReference(app?.uncertain, releases, 'uncertain migration', ['failed', 'activating']),
    active: statusReference(app?.active, releases, 'active release', [app?.retirement ? 'retired' : 'active']), releases, controls };
  if (pruning) report.artifactRetention = { pruningPending: pruning.operation !== null };
  return { ...report, nextChecks: nextChecks(report) };
}

function releaseView(value) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id || '') || !/^[a-f0-9]{64}$/.test(value.digest || '')) throw new Error('Controller returned an invalid deployment reference');
  return { id: value.id, digest: value.digest, submittedAt: recordedTime(value.submittedAt), status: choice(value.status, statuses), step: choice(value.step, steps),
    hasPrivateDiagnostic: Boolean(value.error), secretRevisionSelected: Boolean(value.secretRevision), ...(value.artifactPruned ? { artifactPruned: true } : {}) };
}
function recordedTime(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? value : null;
}
function releaseReference(id, releases, field) {
  if (id == null) return null;
  const value = releases.find(release => release.id === id);
  if (!value) throw new Error(`Application ${field} references an unavailable or different-app release; inspect controller consistency`);
  return { id: value.id, digest: value.digest };
}
function claimReference(claim, releases) {
  if (!claim) return null;
  const reference = statusReference(claim.deployment, releases, 'ownership claim', ['failed', 'activating']);
  if (!reference || reference.digest !== claim.digest) throw new Error('Application ownership claim differs from its recorded release; inspect controller consistency');
  return reference;
}
function statusReference(id, releases, field, allowed) {
  const reference = releaseReference(id, releases, field);
  if (reference && !allowed.includes(releases.find(value => value.id === id).status)) throw new Error(`Application ${field} has an invalid release status; inspect controller consistency`);
  return reference;
}
function controlView(surface, journal, recovery, releases, recoveryError) {
  return { desired: choice(journal.desired, ['running', 'paused']), recordedObserved: choice(journal.observed, ['running', 'paused', 'unknown']),
    recordedObservedAt: recordedTime(journal.observedAt),
    operation: choice(journal.operation, ['pause', 'resume', null]), hold: statusReference(journal.hold, releases, `${surface} hold`, ['failed', 'activating']),
    recoveryError: controlRecoveryError(surface, recoveryError), recoveryAcknowledgmentRequired: Boolean(recovery && recovery.status !== 'acknowledged'), ...recoveryReasons(recovery) };
}
function nextChecks(report) {
  const checks = [
    [report.artifactRetention?.pruningPending, 'Controller artifact pruning is pending. Inspect fogd admin artifacts status and explicitly resume it before controller changes.'],
    [report.retired, 'This name is retired. Inspect the retirement record before planning another installation or reuse.'],
    [report.quarantined, 'The fleet is quarantined. Reconcile its ownership and controller/storage backups before retrying activation.'],
    [report.ownershipClaim, 'An ownership claim is pending. Inspect its original approved release before retrying.'],
    [report.uncertainMigration, 'Migration outcome is uncertain. Inspect the original artifact and migration ledger before retrying or replacing it.'],
    [report.releases.some(value => value.status === 'failed'), 'Activation failed. Inspect private diagnostics in the authenticated admin interface and review the exact artifact before retrying.'],
    [report.releases.some(value => value.status === 'unknown' || value.step === 'unknown'), 'An activation state is unrecognized. Check controller/CLI compatibility and inspect the authenticated admin interface before acting.'],
    [report.releases.some(value => value.status === 'pending'), 'A submission awaits review. Review its artifact and required configuration before exact approval.'],
  ];
  for (const [surface, control] of Object.entries(report.controls)) {
    checks.push([Boolean(control.hold), `${surface === 'delivery' ? 'Queue delivery' : 'Scheduled dispatch'} is held by an activation. Inspect the held release before any retry or replacement.`]);
    checks.push([control.recordedObserved === 'unknown' || control.recordedObservedAt === null || control.recordedObserved !== (control.hold ? 'paused' : control.desired) || control.operation !== null, `Inspect recorded ${surface} status and fleet availability; an operation or observation remains unconfirmed.`]);
    checks.push([control.recoveryAcknowledgmentRequired, `Review ${surface} recovery findings before acknowledgment and a separate explicit resume.`]);
  }
  return checks.filter(([needed]) => needed).map(([, text]) => text);
}
