// Private qualification only. The normal controller must be stopped.
import assert from 'node:assert/strict';
import { Controller } from '/app/packages/platform/src/controller.mjs';
import { Backend } from '/app/packages/platform/src/backend.mjs';
import { deliveryFor } from '/app/packages/platform/src/queue-activation.mjs';
import { stageRequest } from './controller-artifact.mjs';
const [sourceName, name] = process.argv.slice(2);
const controller = new Controller({ dir: process.env.FOGD_DATA_DIR || '/var/lib/fogd', slots: JSON.parse(process.env.FOGD_SLOTS), backend: new Backend() });
await controller.init();
assert.equal(controller.state.apps[name], undefined);
const source = controller.state.apps[sourceName]; assert.ok(source);
const request = await stageRequest(controller, controller.artifact(source.active), async (_dir, config) => { config.name = name; });
await controller.mutate(request.id, request.digest, 'approve');
assert.equal(request.status, 'active', request.error);
const app = controller.state.apps[name], slot = controller.slots.find(s => s.id === app.slot);
await controller.exclusive(() => deliveryFor(controller, app, slot).pause());
console.log(JSON.stringify({ app: name, slot: app.slot, deployment: request.id, digest: request.digest }));
