import { isDeepStrictEqual } from 'node:util';
import { validateDecisionHistory } from '@fogd/platform/decision-history';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hasCronHistory } from '@fogd/platform/cron-history';
import { cronSnapshotProtocol } from './cron-backup.mjs';
import { queueSnapshotProtocol } from './queue-backup.mjs';
import { validateBackgroundEvidence } from './background-backup.mjs';
import { assertSnapshotStateShape } from './snapshot-state-validation.mjs';
import { snapshotState } from './snapshot-state.mjs';
import { assertQueueFreeRecovery } from './queue-safety.mjs';
import { fingerprint } from './bundle.mjs';

export async function restoredInstallationState(dir, manifest, change, now = Date.now()) {
  const source = await snapshotState(dir); assertSnapshotStateShape(source);
  if (change && change.kind !== 'retirement' && hasCronHistory(source)) throw new Error('Scheduled history is not qualified for installation transformations; retain the source and snapshot');
  if (change && change.kind !== 'retirement') { assertQueueFreeRecovery(source); return source.decisions === undefined ? null : structuredClone(source); }
  if (change?.kind === 'retirement' && !change.state) throw new Error('Retirement requires a validated retirement plan');
  const inventory = validateBackgroundEvidence(source, manifest, now);
  const state = structuredClone(change?.state || source);
  validateDecisionHistory(state);
  if (!isDeepStrictEqual(state.decisions, source.decisions)) throw new Error('Installation transformation must retain decision history');
  const queues = inventory.queueRecovery.filter(name => !state.apps[name].retirement);
  const crons = inventory.cronRecovery.filter(name => !state.apps[name].retirement);
  if (queues.length || crons.length) {
    const snapshot = (await fingerprint(join(dir, 'manifest.json'))).sha256;
    if (queues.length) applyRecovery(state, queues, manifest.queueRecovery, snapshot, queueSnapshotProtocol);
    if (crons.length) applyRecovery(state, crons, manifest.cronRecovery, snapshot, cronSnapshotProtocol);
  }
  return state.decisions !== undefined || queues.length || state.requirements?.includes('fogd-queue-retirement-v1') || hasCronHistory(state) || change ? state : null;
}
function applyRecovery(state, names, evidence, snapshot, protocol) {
  state.requirements = [...new Set([...(state.requirements || []), protocol.capability])];
  for (const name of names) {
    const app = state.apps[name];
    app[protocol.recovery] = { id: randomUUID(), status: 'pending', snapshot, prepared: evidence.apps[name], previous: app[protocol.recovery] || null };
    app.route = 'paused';
    delete app[protocol.field];
  }
}
