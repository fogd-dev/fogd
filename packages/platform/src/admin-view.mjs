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
  return { ...controller.state, apps: Object.fromEntries(Object.entries(controller.state.apps).map(([name, app]) => [name, adminApp(app)])), capacity: capacity(controller), deployments: Object.fromEntries(Object.entries(controller.state.deployments).map(([id, request]) => [id, adminDeployment(request)])), secrets: controller.secrets.describe(), credentials: controller.credentials.describe(), quota: controller.quota.describe() };
}

function adminApp(app) {
  const visible = { ...app };
  delete visible.queueSnapshot; delete visible.cronSnapshot;
  if (app.cronRecovery) visible.cronRecovery = cronRecoveryView(app.cronRecovery);
  if (app.retirement?.queue) {
    const { stopQueuedWork, prepared } = app.retirement.queue;
    visible.retirement = { ...app.retirement, queue: { stopQueuedWork, queue: prepared.queue,
      snapshot: { id: prepared.id, at: prepared.at, backlogCount: prepared.observation.backlogCount } } };
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
