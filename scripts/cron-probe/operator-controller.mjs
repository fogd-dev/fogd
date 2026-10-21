// Reopen only the private controller created by the Void refresh qualification.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Controller } from '/app/packages/platform/src/controller.mjs';
import { Backend } from '/app/packages/platform/src/backend.mjs';
import { CronRuntime } from '/app/packages/platform/src/cron-runtime.mjs';
import { dispatchFor } from '/app/packages/platform/src/cron-activation.mjs';
import { server } from '/app/packages/platform/src/http.mjs';
import { readJson, saveJson } from '/app/packages/platform/src/store.mjs';

const [dir, slotId, output] = process.argv.slice(2);
assert.match(dir, /^\/var\/lib\/fogd\/void-cron-[a-f0-9-]+$/);
const slot = JSON.parse(process.env.FOGD_SLOTS).find(value => value.id === slotId); assert.ok(slot);
const backend = new Backend();
let loseReply = false;
const receipt = { step: 'starting', commands: [] };
backend.crons = new CronRuntime({
  inspect: node => backend.deployment(node),
  async run(selected, args) {
    receipt.commands.push(args[1]);
    const result = await backend.run(selected, args);
    if (args[1] === 'resume' && loseReply) { loseReply = false; throw Error('Injected lost successful resume reply'); }
    return result;
  },
});
const controller = new Controller({ cronApps: true, dir, slots: [slot], backend }); await controller.init();
const app = controller.state.apps.refresh;
assert.equal(app.dispatch.hold, null); assert.equal(app.dispatch.desired, 'paused'); assert.equal(app.route, 'active');
const active = controller.state.deployments[app.active]; assert.equal(active.status, 'active');
receipt.active = { deployment: active.id, digest: active.digest };
async function waitForAdoption() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const states = await Promise.all(slot.nodes.map(node => backend.deployment(node).catch(() => null)));
    if (states.every(state => state?.version === active.version)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error('Retained replicas did not adopt the approved deployment');
}
await waitForAdoption();
const credentials = { user: process.env.FOGD_ADMIN_USER, password: process.env.FOGD_ADMIN_PASSWORD, gateway: process.env.FOGD_GATEWAY_TOKEN };
const internal = server(controller, credentials, { role: 'internal' }), admin = server(controller, credentials);
await new Promise(resolve => internal.listen(8084, '0.0.0.0', resolve));
await new Promise(resolve => admin.listen(8085, '0.0.0.0', resolve));
const save = () => saveJson(join(output, 'receipt.json'), receipt);
try {
  receipt.step = 'ready'; await save();
  let commandId;
  const deadline = Date.now() + 10 * 60000;
  while (Date.now() < deadline) {
    const command = await readJson(join(output, 'command.json'), null);
    if (command && command.id !== commandId) {
      commandId = command.id;
      assert.ok(['inspect', 'lose-resume-reply', 'finish'].includes(command.operation));
      if (command.operation === 'lose-resume-reply') loseReply = true;
      receipt.command = { id: command.id, operation: command.operation };
      const publicText = JSON.stringify(command.publicSurfaces || []);
      // Compare values without returning either them or the private runtime ID.
      const secrets = await controller.secrets.select(active, active.secretRevision);
      receipt.privateValuesAbsent = !publicText.includes(active.version) && Object.values(secrets.values).every(value => !publicText.includes(value));
      await waitForAdoption(); receipt.adoptedApprovedVersion = true;
      receipt.native = await backend.crons.status(slot, 'refresh');
      await save();
      if (command.operation === 'finish') break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(receipt.command?.operation, 'finish', 'Operator probe command deadline exceeded');
  receipt.step = 'complete'; await save(); console.log(JSON.stringify(receipt));
} catch (error) {
  receipt.step = 'failed'; await save(); throw error;
} finally {
  if (receipt.step !== 'complete') await controller.exclusive(() => dispatchFor(controller, app, slot).pause());
  await Promise.all([new Promise(resolve => admin.close(resolve)), new Promise(resolve => internal.close(resolve))]);
}
