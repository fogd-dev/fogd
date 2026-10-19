import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { queueRecoveryCapability } from '@fogd/platform/queue-snapshot';
import { queueBackupApps, queueSnapshotEvidence } from './queue-backup.mjs';
import { snapshotState } from './snapshot-state.mjs';
import { assertQueueFreeRecovery } from './queue-safety.mjs';
import { fingerprint } from './bundle.mjs';
import { join } from 'node:path';

export async function restoredQueueState(dir, manifest, change, now = Date.now()) {
  const state = await snapshotState(dir);
  if (change) { assertQueueFreeRecovery(state); return null; }
  const names = queueBackupApps(state), evidence = manifest.queueRecovery;
  if (!names.length) {
    if (evidence) throw new Error('Unexpected queue recovery evidence');
    return null;
  }
  if (!evidence || evidence.schema !== 1 || !evidence.apps) throw new Error('Queued installation recovery requires a qualified snapshot; legacy queued bundles are unsupported');
  const expected = Object.fromEntries(Object.entries(evidence.apps).map(([name, receipt]) => [name, receipt.id]));
  if (!isDeepStrictEqual(queueSnapshotEvidence(state, expected, now), evidence)) throw new Error('Queue snapshot evidence differs from archived controller metadata');
  const snapshot = (await fingerprint(join(dir, 'manifest.json'))).sha256;
  state.requirements = [...new Set([...state.requirements, queueRecoveryCapability])];
  for (const name of names) {
    state.apps[name].queueRecovery = { id: randomUUID(), status: 'pending', snapshot, prepared: evidence.apps[name], previous: state.apps[name].queueRecovery || null };
    state.apps[name].route = 'paused';
    delete state.apps[name].queueSnapshot;
  }
  return state;
}
