const failures = {
  approved: 'Activation could not start. Ask an administrator to inspect this release.',
  publishing: 'Publishing failed. The application remains paused; an administrator can inspect and retry.',
  'waiting-for-replicas': 'The replicas did not adopt this release. Ask an administrator to check their health.',
  'checking-migration-ledger': 'Migration history could not be verified. An administrator must reconcile it before retrying.',
  migrating: 'A database migration failed or was interrupted. Ask an administrator to inspect the migration before retrying.',
  complete: 'Activation was interrupted while recording its result. Ask an administrator to inspect this release.',
};

// Backend errors can contain command output, credentials, or SQL data. Status uses
// fixed explanations; raw diagnostics remain available only to administrators.
export function deploymentStatus(request) {
  const { id, app, digest, status, submittedAt } = request;
  const step = request.step === 'submitted' || Object.hasOwn(failures, request.step) ? request.step : 'unknown';
  return { id, app, digest, status, submittedAt, step,
    error: status === 'failed' ? failures[step] || 'Activation failed. Ask an administrator to inspect this release.' : null };
}
