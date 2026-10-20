import { CronDispatch, initialCronDispatch, validateCronDispatch, cronCapability, cronScript, requireCronCapability } from './cron-dispatch.mjs';

export function dispatchFor(controller, app, slot) {
  return new CronDispatch({ state: app.dispatch, slot, runtime: controller.backend.crons, clock: controller.clock,
    persist: async state => { controller.assertStorage(); app.dispatch = state; await controller.save(); } });
}

export function validateCronState(state, runtime) {
  const declarations = [...Object.values(state.apps), ...Object.values(state.deployments)].filter(record => Object.hasOwn(record.resources || {}, 'crons'));
  if (declarations.length && !state.requirements?.includes(cronCapability)) throw new Error('Cron declarations require their capability marker');
  if (declarations.length) requireCronRuntime(runtime);
  declarations.forEach(record => cronScript(record.resources));
  for (const [name, app] of Object.entries(state.apps)) {
    if (app.resources?.crons && app.active && !app.dispatch) throw new Error('Active scheduled app is missing its dispatch journal');
    if (!app.dispatch && !app.cronBootstrap) continue;
    if (!state.requirements?.includes(cronCapability)) throw new Error('Cron state requires its capability marker');
    validateAppCron(state, name, app);
  }
}

function validateAppCron(state, name, app) {
  validateCronDispatch(app.dispatch);
  if (app.dispatch.script !== name || cronScript(app.resources) !== name) throw new Error('Cron dispatch identity mismatch');
  if (app.uncertain && app.uncertain !== app.dispatch.hold) throw new Error('Uncertain cron migration conflicts with dispatch hold');
  validateCronApproval(state, name, app);
  const bootstrap = app.cronBootstrap;
  if (!bootstrap || !['pending', 'ready', 'application'].includes(bootstrap.phase)) throw new Error('Invalid cron bootstrap progress');
  if (bootstrap.phase === 'ready' && (typeof bootstrap.version !== 'string' || !bootstrap.version)) throw new Error('Missing cron bootstrap version');
}

function validateCronApproval(state, name, app) {
  const dispatch = app.dispatch;
  if (dispatch.hold) {
    const owner = state.deployments[dispatch.hold];
    if (!isCronApproval(state, name, owner) || !['failed', 'activating'].includes(owner.status)) throw new Error('Invalid cron activation hold owner');
    return;
  }
  const approved = Object.values(state.deployments).some(request => isCronApproval(state, name, request) && request.version === dispatch.version && ['active', 'activating'].includes(request.status));
  if (!approved || app.cronBootstrap?.phase !== 'application') throw new Error('Cron dispatch has no matching approved application version');
}

function isCronApproval(state, name, request) {
  return Boolean(request && state.deployments[request.id] === request && request.app === name && Object.hasOwn(request, 'secretRevision') && cronScript(request.resources || {}) === name);
}

export function interruptCronActivation(app, request) {
  if (!app?.dispatch) return;
  if (app.dispatch.hold && app.dispatch.hold !== request.id) throw new Error('Interrupted activation conflicts with another cron hold');
  app.route = 'paused';
  // Even a saved release observation can precede the final active pointer.
  app.dispatch = { ...app.dispatch, hold: request.id, observed: 'unknown', observedAt: null, operation: 'pause' };
}

export async function recoverCronHolds(controller) {
  for (const app of Object.values(controller.state.apps)) {
    if (!app.dispatch?.hold || app.quarantined || app.cronBootstrap.phase === 'pending') continue;
    const slot = controller.slots.find(value => value.id === app.slot);
    if (!slot) throw new Error('Cron fleet is missing');
    try {
      if (app.cronBootstrap.phase === 'ready') await controller.backend.ready(slot, app.cronBootstrap.version);
      await dispatchFor(controller, app, slot).reconcile();
      delete app.dispatchRecoveryError;
    } catch {
      controller.assertStorage();
      app.route = 'paused';
      app.dispatch = { ...app.dispatch, operation: 'pause', observed: 'unknown', observedAt: null };
      app.dispatchRecoveryError = 'Cron pause could not be confirmed; retry the held activation after restoring its fleet';
    }
    await controller.save();
  }
}

function requireCronRuntime(runtime) {
  if (!['pause', 'resume', 'status'].every(verb => typeof runtime?.[verb] === 'function')) throw new Error('Experimental cron activation requires the qualified runtime transport');
}

export function assertCronDecision(app, request, action, replaces, runtime) {
  if (request.resources.crons && action !== 'reject') requireCronRuntime(runtime);
  if (request.resources.crons && replaces !== undefined) throw new Error('Replacing a held cron activation is not qualified; retry the original artifact');
  if (!app?.dispatch?.hold) return;
  if (action === 'reject' && app.dispatch.hold !== request.id) return;
  if (action === 'reject' || app.dispatch.hold !== request.id) throw new Error('Retry the held cron activation before changing its approval');
}

export async function prepareCron(controller, request, app, slot, execution, step) {
  const script = cronScript(request.resources);
  if (!script) return null;
  if (!controller.backend.crons) throw new Error('Experimental cron activation requires the qualified runtime transport');
  if (!app.dispatch) {
    if (app.active || await controller.backend.hasDeployment(slot)) throw new Error('Cron bootstrap requires an unpublished fleet; restore matching metadata');
    requireCronCapability(controller.state, request.resources);
    app.dispatch = initialCronDispatch(script, request.id);
    app.cronBootstrap = { phase: 'pending' };
    await step('cron-bootstrap-intent');
  }
  if (app.cronBootstrap.phase === 'pending') {
    await step('publishing-cron-bootstrap');
    const version = await controller.backend.bootstrap(slot, execution, request.resources);
    app.cronBootstrap = { phase: 'ready', version };
    await step('waiting-for-cron-bootstrap');
  }
  if (app.cronBootstrap.phase === 'ready') await controller.backend.ready(slot, app.cronBootstrap.version);
  const dispatch = dispatchFor(controller, app, slot);
  await step('pausing-dispatch');
  await dispatch.hold(request.id);
  delete app.dispatchRecoveryError; await controller.save();
  return dispatch;
}

export async function markCronApplication(app, dispatch, step) {
  if (!dispatch) return;
  app.cronBootstrap = { phase: 'application' };
  await step('cron-application-intent');
}
