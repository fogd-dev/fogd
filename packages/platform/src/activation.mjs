import { prepareQueue, markQueueApplication } from './queue-activation.mjs';
import { prepareCron, markCronApplication } from './cron-activation.mjs';

async function prepareBackground(controller, request, app, slot, execution, step) {
  const cron = Boolean(request.resources.crons);
  const control = await (cron ? prepareCron : prepareQueue)(controller, request, app, slot, execution, step);
  return control ? { control, mark: cron ? markCronApplication : markQueueApplication, releaseStep: cron ? 'releasing-dispatch' : 'releasing-delivery' } : null;
}

async function publish(controller, request, slot, execution, step) {
  await step('publishing');
  request.version = await controller.backend.publish(slot, execution);
  await step('waiting-for-replicas');
  await controller.backend.ready(slot, request.version);
  if ((request.requiredSecrets || []).length) {
    await step('validating-application');
    await controller.backend.applicationReady(slot);
  }
}

async function migrate(controller, request, app, slot, execution, step) {
  if (app.uncertain && app.uncertain !== request.id) throw new Error('Reconcile the original migration attempt before starting another');
  app.uncertain = request.id; await step('checking-migration-ledger');
  await controller.reconcile(app, slot);
  app.uncertain = request.id; await step('migrating');
  await controller.backend.migrate(slot, execution, request.resources);
  await controller.reconcile(app, slot);
}

async function finish(controller, request, app, step) {
  app.active = request.id; app.route = 'active';
  for (const other of Object.values(controller.state.deployments)) {
    if (other.app === request.app && other.id !== request.id && ['pending', 'failed', 'active'].includes(other.status)) other.status = 'superseded';
  }
  request.status = 'active'; await step('complete');
}

async function failed(controller, request, app, slot) {
  // Queue failures retain their hold. Reconciliation can write D1, so defer it
  // until explicit retry has established pause again (resume may be uncertain).
  if (request.resources.queues || request.resources.crons) return;
  try { await controller.reconcile(app, slot); }
  catch (error) { request.error += app.privateConfiguration ? '; migration reconciliation pending' : `; migration reconciliation pending: ${error.message}`; }
}

export async function activateRelease(controller, request, app, slot, selected) {
  let execution = controller.artifact(request.id);
  const step = async value => { request.step = value; await controller.save(); };
  try {
    app.resources = structuredClone(request.resources);
    await step('approved');
    execution = await controller.secrets.materialize(request, execution, selected.values);
    const background = await prepareBackground(controller, request, app, slot, execution, step);
    if (!app.active && !background) await publish(controller, request, slot, execution, step);
    await migrate(controller, request, app, slot, execution, step);
    if (background) await background.mark(app, background.control, step);
    if (app.active || background) await publish(controller, request, slot, execution, step);
    if (background) {
      await step(background.releaseStep);
      await background.control.completeActivation(request.id, request.version);
    }
    await finish(controller, request, app, step);
  } catch (error) {
    controller.assertStorage();
    request.status = 'failed'; request.error = app.privateConfiguration ? 'Private activation failed; secret values and runtime diagnostics are withheld. Check the recorded step and retry explicitly.' : error.message; app.route = 'paused';
    await failed(controller, request, app, slot);
    await controller.save();
  } finally {
    try { await controller.secrets.cleanup(request.id); }
    catch (error) { controller.assertStorage(); throw error; }
  }
  return request;
}
