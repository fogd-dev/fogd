import { Delivery, initialDelivery, validateDelivery } from './delivery.mjs';

export const queueCapability = 'fogd-queue-activation-v1';

// Admission defaults off. These checks also protect internally staged probes.
export function activationQueue(resources) {
  const queues = resources.queues;
  if (!queues) return null;
  if (queues.producers?.length !== 1 || queues.consumers?.length !== 1 || queues.producers[0].queue !== queues.consumers[0].queue) throw new Error('Activation requires one same-app produced and consumed queue');
  return queues.consumers[0].queue;
}

export function deliveryFor(controller, app, slot) {
  return new Delivery({ state: app.delivery, slot, runtime: controller.backend.queues,
    persist: async state => { controller.assertStorage(); delete app.queueSnapshot; app.delivery = state; await controller.save(); } });
}

export function requireQueueCapability(state, resources) {
  if (activationQueue(resources)) state.requirements = [...new Set([...(state.requirements || []), queueCapability])];
}

export function validateQueueState(state) {
  const queued = [...Object.values(state.apps), ...Object.values(state.deployments)].some(record => record.resources?.queues);
  if (queued && !state.requirements?.includes(queueCapability)) throw new Error('Queue declarations require their capability marker');
  for (const [name, app] of Object.entries(state.apps)) {
    if (!app.delivery && !app.queueBootstrap) continue;
    if (!state.requirements?.includes(queueCapability)) throw new Error('Queue state requires its capability marker');
    validateAppQueue(state, name, app);
  }
}

function validateAppQueue(state, name, app) {
  validateDelivery(app.delivery);
  if (app.uncertain && app.uncertain !== app.delivery.hold) throw new Error(`Uncertain migration ${app.uncertain} conflicts with delivery hold ${app.delivery.hold} for ${name}`);
  const owner = state.deployments[app.delivery.hold];
  if (app.delivery.hold && (!owner || owner.app !== name || !['failed', 'activating'].includes(owner.status))) throw new Error('Invalid queue activation hold owner');
  if (activationQueue(app.resources) !== app.delivery.queue) throw new Error('Queue delivery identity mismatch');
  const bootstrap = app.queueBootstrap;
  if (!bootstrap || !['pending', 'ready', 'application'].includes(bootstrap.phase)) throw new Error('Invalid queue bootstrap progress');
  if (bootstrap.phase === 'ready' && !bootstrap.version) throw new Error('Missing queue bootstrap version');
}

export function interruptQueueActivation(app, request) {
  if (!app?.delivery) return;
  if (app.delivery.hold && app.delivery.hold !== request.id) throw new Error(`Interrupted activation conflicts with another delivery hold: ${request.id} / ${app.delivery.hold}`);
  app.route = 'paused';
  // Resume may have committed before the final active pointer was saved.
  app.delivery = { ...app.delivery, hold: request.id, observed: 'unknown', observedAt: null, operation: 'pause' };
}

export async function recoverQueueHolds(controller) {
  for (const app of Object.values(controller.state.apps)) {
    if (!app.delivery?.hold || app.retirement || app.quarantined || app.queueBootstrap.phase === 'pending') continue;
    const slot = controller.slots.find(value => value.id === app.slot);
    if (!slot) throw new Error('Queue fleet is missing');
    try {
      if (app.queueBootstrap.phase === 'ready') await controller.backend.ready(slot, app.queueBootstrap.version);
      await deliveryFor(controller, app, slot).reconcile();
      delete app.deliveryRecoveryError;
    } catch {
      controller.assertStorage();
      // Queue availability is local to its app. Never migrate or resume here.
      app.route = 'paused';
      app.delivery = { ...app.delivery, operation: 'pause', observed: 'unknown', observedAt: null };
      app.deliveryRecoveryError = 'Queue pause could not be confirmed; retry the held activation after restoring its fleet';
    }
    await controller.save();
  }
}

export function assertQueueDecision(app, request, action, replacement = false) {
  if (action !== 'reject' && app?.queueRecovery && app.queueRecovery.status !== 'acknowledged') throw new Error('Acknowledge restored queue recovery before approving another deployment');
  if (!app?.delivery?.hold) return;
  if (action === 'reject') {
    if (app.delivery.hold === request.id) throw new Error('Retry the held queue activation before rejecting its artifact');
    return;
  }
  if (app.delivery.hold !== request.id && !replacement) throw new Error('Retry the held queue activation before approving another deployment');
}

export async function prepareQueue(controller, request, app, slot, execution, step) {
  const queue = activationQueue(request.resources);
  if (!queue) return null;
  if (!app.delivery) {
    if (app.active || await controller.backend.hasDeployment(slot)) throw new Error('Queue bootstrap requires an unpublished fleet; restore matching metadata');
    requireQueueCapability(controller.state, request.resources);
    app.delivery = initialDelivery(queue, request.id);
    app.queueBootstrap = { phase: 'pending' };
    await step('queue-bootstrap-intent');
  }
  if (app.queueBootstrap.phase === 'pending') {
    await step('publishing-queue-bootstrap');
    const version = await controller.backend.bootstrap(slot, execution, request.resources);
    app.queueBootstrap = { phase: 'ready', version };
    await step('waiting-for-queue-bootstrap');
  }
  if (app.queueBootstrap.phase === 'ready') await controller.backend.ready(slot, app.queueBootstrap.version);
  const delivery = deliveryFor(controller, app, slot);
  await step('pausing-delivery');
  await delivery.hold(request.id);
  delete app.deliveryRecoveryError; await controller.save();
  return delivery;
}

export async function markQueueApplication(app, delivery, step) {
  if (!delivery) return;
  // This write must precede consumer publication, including a lost response.
  // Retrying this phase may republish the approved app, never the bootstrap.
  app.queueBootstrap = { phase: 'application' };
  await step('queue-application-intent');
}
