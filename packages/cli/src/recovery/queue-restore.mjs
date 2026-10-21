import { queueBackupApps, queueSnapshotProtocol } from './queue-backup.mjs';
import { validateSnapshotEvidence } from './snapshot-evidence.mjs';

export function validateQueueEvidence(state, manifest, now = Date.now()) {
  const names = queueBackupApps(state), evidence = manifest.queueRecovery;
  validateSnapshotEvidence(state, evidence, names, queueSnapshotProtocol, now);
  return names;
}
