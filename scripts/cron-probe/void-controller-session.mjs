// A private qualification controller serves normal authenticated gateway lookups.
// File commands keep experimental dispatch controls out of the public app API.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { Controller } from '/app/packages/platform/src/controller.mjs';
import { Backend } from '/app/packages/platform/src/backend.mjs';
import { CronRuntime } from '/app/packages/platform/src/cron-runtime.mjs';
import { dispatchFor } from '/app/packages/platform/src/cron-activation.mjs';
import { server } from '/app/packages/platform/src/http.mjs';
import { saveJson, readJson } from '/app/packages/platform/src/store.mjs';
import { stageRequest } from './controller-artifact.mjs';
import { regularFiles } from '/app/packages/runtime/src/artifact.mjs';
import { adminState } from '/app/packages/platform/src/admin-view.mjs';

import { updateApprover } from './controller-update.mjs';
import { waitForMinuteBoundary } from './minute.mjs';

export async function serveVoidController(source, slotId, output, minutes = 12) {
  assert.ok(Number.isSafeInteger(minutes) && minutes >= 12 && minutes <= 45, 'Private fixture duration must be 12–45 minutes');
  const slot = JSON.parse(process.env.FOGD_SLOTS).find(value => value.id === slotId); assert.ok(slot);
  const backend = new Backend();
  backend.crons = new CronRuntime({ run: (slot, args) => backend.run(slot, args), inspect: node => backend.deployment(node) });
  assert.equal(await backend.owner(slot), null); assert.equal(await backend.hasDeployment(slot), false);
  const dir = join(process.env.FOGD_DATA_DIR || '/var/lib/fogd', `void-cron-${randomUUID()}`);
  const controller = new Controller({ dir, slots: [slot], backend }); await controller.init();
  const internal = server(controller, { user: process.env.FOGD_ADMIN_USER, password: process.env.FOGD_ADMIN_PASSWORD, gateway: process.env.FOGD_GATEWAY_TOKEN }, { role: 'internal' });
  await new Promise(resolve => internal.listen(8084, '0.0.0.0', resolve));
  let request, commandStep;
  const receipt = { step: 'pending', slot: slot.id };
  const save = () => saveJson(join(output, 'receipt.json'), receipt);
  try {
    const token = randomBytes(32).toString('hex');
    const selected = await controller.replaceSecrets('refresh', { REFRESH_TOKEN: token });
    const approveUpdate = updateApprover({ controller, backend, slot, output, receipt, save, token, revision: selected.revision,
      onRequest: value => { request = value; }, onStep: value => { commandStep = value; } });
    request = await stageRequest(controller, source, async () => {}, { requiredSecrets: ['REFRESH_TOKEN'] });
    for (const file of await regularFiles(controller.artifact(request.id))) assert.ok(!(await readFile(join(controller.artifact(request.id), file), 'utf8')).includes(token));
    receipt.digest = request.digest; await save();
    const boundary = await waitForMinuteBoundary();
    assert.equal(await backend.hasDeployment(slot), false);
    receipt.preapprovalBoundary = boundary;
    await controller.mutate(request.id, request.digest, 'approve', selected.revision);
    assert.equal(request.status, 'active', `Native activation failed at ${request.step}`);
    assert.ok(!JSON.stringify(adminState(controller)).includes(token));
    receipt.privateValueAbsentFromArtifactAndStatus = true;
    receipt.step = 'active'; receipt.artifact = controller.artifact(request.id);
    receipt.migrations = controller.state.apps.refresh.migrations; await save();
    const deadline = Date.now() + minutes * 60000;
    let commandId;
    while (Date.now() < deadline) {
      const command = await readJson(join(output, 'command.json'), null);
      if (command && command.id !== commandId) {
        commandId = command.id;
        assert.ok(['pause', 'resume', 'finish', 'update'].includes(command.operation));
        if (command.operation === 'update') await approveUpdate(command);
        else if (command.operation !== 'finish') await controller.exclusive(() => dispatchFor(controller, controller.state.apps.refresh, slot)[command.operation]());
        receipt.command = { id: command.id, operation: command.operation };
        receipt.dispatch = controller.state.apps.refresh.dispatch; await save();
        if (command.operation === 'finish') break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(receipt.command?.operation, 'finish', 'Native fixture command deadline exceeded');
    receipt.step = 'complete'; receipt.dispatch = controller.state.apps.refresh.dispatch; await save();
    console.log(JSON.stringify(receipt));
  } catch (error) {
    receipt.step = 'failed'; receipt.error = `Native fixture failed at ${commandStep || request?.step || 'staging'}`; await save();
    throw error;
  } finally {
    if (controller.state.apps.refresh?.dispatch) await controller.exclusive(() => dispatchFor(controller, controller.state.apps.refresh, slot).pause());
    await new Promise(resolve => internal.close(resolve));
  }
}
