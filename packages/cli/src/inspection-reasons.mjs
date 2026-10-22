// Compatibility vocabulary for the qualified controller's recorded messages.
// Unknown text is deliberately not copied into an operator report.
const quarantine = [
  'Bucket owner has no controller record; restore controller backup',
  'Multiple bucket slots claim this app; reconcile bucket and controller backups',
  'Pending ownership claim contains deployment objects; restore matching metadata',
  'Pending ownership intent does not match approved artifact or configured fleet',
  'Configured slot or bucket owner is missing/mismatched; restore matching bucket, config, and controller backups',
];
const diagnoses = [
  'Possible message expiration or completion during snapshot shutdown; reconcile retained application input before acknowledging',
  'Restored native dispatch was not held; work may have run before confirmation. Restore a qualified stopped snapshot.',
  'Restored native hold revision differs from snapshot; control history or stored state changed. Work may have run. Restore a qualified stopped snapshot.',
];
const recoveryErrors = [
  'Queue runtime is unavailable or its approved generation is not ready; retry after the replicas recover',
  'Queue recovery approval, ownership, or retention contract differs; restore matching metadata and images',
  'Restored dispatch was not held; restore a qualified stopped snapshot before using this app',
  'Cron recovery approval or hold revision differs from snapshot; restore matching metadata, volumes and images',
  'Cron hold or approved runtime could not be confirmed; retry after its replicas recover, or restore matching metadata and images',
];
const knownText = (value, allowed) => allowed.includes(value) ? value : 'unrecognized';
export const quarantineReason = app => app?.quarantined ? knownText(app.reason, quarantine) : null;
export function recoveryReasons(recovery) {
  const values = Array.isArray(recovery?.diagnoses) ? recovery.diagnoses : recovery?.diagnosis ? [recovery.diagnosis] : [];
  return { recoveryFindings: [...new Set(values.map(value => knownText(value, diagnoses)))],
    recoveryCheckError: recovery?.checkError ? knownText(recovery.checkError, recoveryErrors) : null };
}

const controlRecoveryErrors = {
  delivery: 'Queue pause could not be confirmed; retry the held activation after restoring its fleet',
  dispatch: 'Cron pause could not be confirmed; retry the held activation after restoring its fleet',
};
export function controlRecoveryError(surface, value) {
  return value ? knownText(value, [controlRecoveryErrors[surface]]) : null;
}
