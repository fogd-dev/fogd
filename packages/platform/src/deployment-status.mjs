const failures = {
  'preparing-activation': 'Activation preparation failed. Ask an administrator to inspect and retry this release.',
  approved: 'Activation could not start. Ask an administrator to inspect this release.',
  publishing: 'Publishing failed. The application remains paused; an administrator can inspect and retry.',
  'waiting-for-replicas': 'The replicas did not adopt this release. Ask an administrator to check their health.',
  'checking-migration-ledger': 'Migration history could not be verified. An administrator must reconcile it before retrying.',
  'validating-application': 'The application environment failed validation. Ask an administrator to check the declared configuration.',
  migrating: 'A database migration failed or was interrupted. Ask an administrator to inspect the migration before retrying.',
  'queue-bootstrap-intent': 'Queue activation preparation failed. An administrator must inspect and retry this release.',
  'publishing-queue-bootstrap': 'Queue bootstrap publication is uncertain. An administrator must inspect and retry this release.',
  'waiting-for-queue-bootstrap': 'The replicas did not adopt the queue bootstrap. Ask an administrator to check their health.',
  'pausing-delivery': 'Queue delivery pause could not be confirmed. An administrator must inspect the fleet before retrying.',
  'queue-application-intent': 'Queue application publication could not start. An administrator must inspect and retry this release.',
  'releasing-delivery': 'Queue delivery release is uncertain. An administrator must inspect and retry this release.',
  'transferring-delivery-hold': 'Queue replacement hold transfer is uncertain. An administrator must inspect both releases before retrying.',
  'cron-bootstrap-intent': 'Scheduled activation preparation failed. An administrator must inspect and retry this release.',
  'publishing-cron-bootstrap': 'Database bootstrap publication is uncertain. An administrator must inspect and retry this release.',
  'waiting-for-cron-bootstrap': 'The replicas did not adopt the database bootstrap. Ask an administrator to check their health.',
  'pausing-dispatch': 'Scheduled dispatch pause could not be confirmed. An administrator must restore the fleet before retrying.',
  'cron-application-intent': 'Scheduled application publication could not start. An administrator must inspect and retry this release.',
  'releasing-dispatch': 'Scheduled dispatch release is uncertain. An administrator must inspect and retry this release.',
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
