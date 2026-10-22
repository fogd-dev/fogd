import { randomUUID } from 'node:crypto';

export function cronSnapshotSource({ deployment = randomUUID(), id = randomUUID(), at = Date.now() } = {}) {
  const version = 'private-cron-runtime-version', digest = 'c'.repeat(64);
  const resources = { script: 'refresh', crons: ['* * * * *'], r2: [], d1: [], durable: { bindings: [] } };
  const receipt = { schema: 1, id, deployment, digest, version, script: 'refresh', slot: 'two', at, completedAt: at,
    secretRevision: null, crons: resources.crons,
    beforePause: { paused: false, revision: 1, nextAlarm: at + 60000, crons: resources.crons },
    observation: { paused: true, revision: 2, nextAlarm: null, crons: resources.crons } };
  const app = { active: deployment, slot: 'two', route: 'active', resources,
    cronBootstrap: { phase: 'application' }, cronSnapshot: receipt,
    dispatch: { schema: 1, script: 'refresh', desired: 'paused', observed: 'paused', observedAt: new Date(at).toISOString(), hold: null, operation: null, version } };
  const request = { id: deployment, app: 'refresh', status: 'active', step: 'complete', digest, version, secretRevision: null, resources };
  return { receipt, expected: { queueRecovery: {}, cronRecovery: { refresh: id } },
    state: { requirements: ['fogd-cron-activation-v1'], apps: { refresh: app }, deployments: { [deployment]: request } } };
}
