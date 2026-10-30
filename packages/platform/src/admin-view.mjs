import { artifactPruneStatus } from './artifact-prune-state.mjs';
import { cronRecoveryView } from './cron-recovery.mjs';
import { cronUpdateNotice } from './cron-dispatch.mjs';
import { capacity } from './capacity.mjs';

// celld versions hash the materialized config, including private vars. Keep them
// in controller storage for readiness/recovery, not in API inspection responses.
export function adminDeployment(request) {
  const visible = { ...request };
  if (request.secretRevision) delete visible.version;
  if (request.resources?.crons) visible.backgroundWorkNotice = cronUpdateNotice;
  return visible;
}
export function adminState(controller) {
  const { artifactPruning, decisions, appArchives, ...state } = controller.state;
  const pruning = artifactPruning ? { artifactPruning: artifactPruneStatus(controller.state) } : {};
  const archives = appArchives ? { appArchives: archiveSummary(appArchives) } : {};
  return { ...state, ...pruning, ...archives, decisionHistory: { count: decisions?.length || 0, unconfirmed: (decisions || []).filter(entry => ['started', 'unconfirmed'].includes(entry.outcome)).length }, apps: Object.fromEntries(Object.entries(controller.state.apps).map(([name, app]) => [name, adminApp(app)])), capacity: capacity(controller), deployments: Object.fromEntries(Object.entries(controller.state.deployments).map(([id, request]) => [id, adminDeployment(request)])), secrets: controller.secrets.describe(), credentials: controller.credentials.describe(), quota: controller.quota.describe() };
}

function adminApp(app) {
  const visible = { ...app };
  if (app.archiveRecovery) {
    const { archive, identity, status, rotation } = app.archiveRecovery;
    visible.archiveRecovery = { archive, identity, status, ...(rotation ? { rotation: { secretRevision: rotation.secretRevision, state: 'pending' } } : {}) };
  }
  if (app.retirement) visible.retirement = retirementIdentity(app.retirement);
  delete visible.queueSnapshot; delete visible.cronSnapshot;
  if (app.cronRecovery) visible.cronRecovery = cronRecoveryView(app.cronRecovery);
  if (app.retirement?.queue) {
    const { stopQueuedWork, prepared } = app.retirement.queue;
    visible.retirement = { ...retirementIdentity(app.retirement), queue: { stopQueuedWork, queue: prepared.queue,
      snapshot: { id: prepared.id, at: prepared.at, backlogCount: prepared.observation.backlogCount } } };
  }
  if (app.retirement?.cron) {
    const { stopScheduledWork, prepared } = app.retirement.cron;
    visible.retirement = { ...retirementIdentity(app.retirement), cron: { stopScheduledWork, crons: prepared.crons,
      snapshot: { id: prepared.id, at: prepared.at, revision: prepared.observation.revision } } };
  }
  if (app.queueRecovery) {
    const { id, status, diagnosis, checkError, checkedAt, acknowledgedAt } = app.queueRecovery;
    visible.queueRecovery = { id, status, diagnosis, checkError, checkedAt, acknowledgedAt };
  }
  for (const field of ['delivery', 'queueBootstrap', 'dispatch', 'cronBootstrap']) {
    if (!app[field]) continue;
    const { version: _version, ...state } = app[field];
    visible[field] = state;
  }
  return visible;
}

function retirementIdentity(retirement) {
  const { id, at, app, digest, snapshot, previous, replacement, deployment } = retirement;
  return { id, at, app, digest, snapshot, previous, replacement, deployment };
}

function archiveSummary(registry) {
  return { schema: registry.schema, records: Object.fromEntries(Object.entries(registry.records).map(([id, record]) =>
    [id, { id: record.id, name: record.name, at: record.at, digest: record.digest, status: record.status }])) };
}
