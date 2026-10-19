import { stageRequest } from './controller-artifact.mjs';
// Run only inside a disposable probe container with a never-deployed fleet.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Controller } from '/app/packages/platform/src/controller.mjs';
import { Backend } from '/app/packages/platform/src/backend.mjs';
import { deliveryFor } from '/app/packages/platform/src/queue-activation.mjs';

const [source, slotId] = process.argv.slice(2);
const slot = JSON.parse(process.env.FOGD_SLOTS).find(slot => slot.id === slotId);
assert.ok(slot); const backend = new Backend();
assert.equal(await backend.owner(slot), null, 'Probe requires an unclaimed fleet');
assert.equal(await backend.hasDeployment(slot), false, 'Probe requires a never-deployed fleet');
const dir = join(process.env.FOGD_DATA_DIR || '/var/lib/fogd', `qualification-${randomUUID()}`);
const create = () => new Controller({ dir, slots: [slot], backend });
let controller = create(); await controller.init();
const initial = await stage();
assert.equal(await backend.hasDeployment(slot), false, 'Staging must not publish');
const resume = backend.queues.resume.bind(backend.queues);
let loseResponse = true;
backend.queues.resume = async (...args) => {
  const result = await resume(...args);
  if (loseResponse) { loseResponse = false; throw Error('Probe: lost successful resume response'); }
  return result;
};
await controller.mutate(initial.id, initial.digest, 'approve');
assert.equal(initial.status, 'failed', initial.error);
assert.match(initial.error, /lost successful resume/);
assert.equal((await backend.queues.status(slot, 'imports')).paused, false);
assert.equal(controller.state.apps.imports.delivery.hold, initial.id);
controller = create(); await controller.init();
assert.equal((await backend.queues.status(slot, 'imports')).paused, true);
assert.equal(controller.route('imports.localhost').state, 'paused');
const retried = controller.state.deployments[initial.id];
await controller.mutate(retried.id, retried.digest, 'approve');
assert.equal(retried.status, 'active', retried.error);
const first = { version: retried.version, step: retried.step, migrations: controller.state.apps.imports.migrations };
await controller.exclusive(() => deliveryFor(controller, controller.state.apps.imports, slot).pause());
const update = await stage(true); await controller.mutate(update.id, update.digest, 'approve');
assert.equal(update.status, 'active', update.error);
assert.notEqual(update.version, retried.version, 'Update must adopt a distinct runtime version');
assert.equal((await backend.queues.status(slot, 'imports')).paused, true);
const state = controller.state.apps.imports;
assert.equal(state.queueBootstrap.phase, 'application');
assert.equal(state.delivery.desired, 'paused'); assert.equal(state.delivery.hold, null);
console.log(JSON.stringify({ dir, slot: slot.id, first, update: { version: update.version, step: update.step }, delivery: state.delivery, bootstrap: state.queueBootstrap, lostResumeRecovered: true }));

async function stage(update = false) {
  return stageRequest(controller, source, async (_artifact, config) => {
    if (update) config.vars = { ...config.vars, FOGD_PROBE_REVISION: '2' };
  });
}
