// This function is also embedded in the verified installation image's helper.
// Authority is supplied by that image, never by candidate application code.
export function compareCandidate(state, release, capabilities, { Controller, assertLiveName }) {
  const unknown = { status: 'unverified', reason: 'state' };
  const context = comparisonContext(state, release.app);
  if (!context) return unknown;
  const { app, appliedMigrations } = context;
  try {
    assertLiveName(state, release.app);
    Controller.prototype.assertAdmission.call(capabilities, release);
    const changes = Controller.prototype.compatible.call({ state }, release, app);
    return { status: 'supported', reason: 'compatible', existingApp: Boolean(app),
      r2Added: changes.r2Added.length, appliedMigrations,
      pendingMigrations: release.migrations.length - appliedMigrations };
  } catch (error) {
    const reasons = [
      ['Resource identities changed:', 'resource-identity'], ['Adding or removing cron dispatch', 'cron-transition'],
      ['Applied migration changed:', 'migration-history'], ['Slot quarantined:', 'quarantined'],
      ['App name is permanently retired;', 'retired'], ['Queue applications are not enabled', 'queue-admission'],
      ['Scheduled applications are not enabled', 'cron-admission'],
    ];
    const reason = reasons.find(([prefix]) => error?.message?.startsWith(prefix))?.[1];
    return reason ? { status: 'unsupported', reason } : unknown;
  }
}

export function comparisonContext(state, name) {
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!record(state) || !record(state.apps) || !record(state.deployments)) return null;
  const exists = Object.hasOwn(state.apps, name), app = exists ? state.apps[name] : null;
  if (exists && (!record(app) || !retainedResources(app.resources) || !Array.isArray(app.migrations))) return null;
  const active = app?.active ? state.deployments[app.active] : null;
  if (app?.active && (!record(active) || active.app !== name || !retainedResources(active.resources))) return null;
  return { app, appliedMigrations: app?.migrations.length || 0 };
}

export function retainedResources(value) {
  return value && typeof value.script === 'string' && Array.isArray(value.d1) && Array.isArray(value.r2) && Array.isArray(value.durable?.bindings);
}
