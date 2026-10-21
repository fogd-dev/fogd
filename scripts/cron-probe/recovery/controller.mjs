// Private full-installation qualification. This file and its staging helper live
// inside the controller volume and travel with the verified stopped archive.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Backend } from '/app/packages/platform/src/backend.mjs';
import { CronRuntime } from '/app/packages/platform/src/cron-runtime.mjs';
import { startController } from '/app/packages/platform/src/startup.mjs';
import { operateDispatch } from '/app/packages/platform/src/admin-dispatch.mjs';
import { readJson, saveJson } from '/app/packages/platform/src/store.mjs';
import { stageRequest } from './controller-artifact.mjs';

assert.match(process.env.COMPOSE_PROJECT_NAME || '', /^fogd-m11c-cron-recovery/);
const dir = '/var/lib/fogd', qualification = join(dir, 'qualification');
const backend = new Backend();
backend.crons = new CronRuntime({ run: (slot, args) => backend.run(slot, args), inspect: node => backend.deployment(node) });
const { controller } = await startController(backend);
let last = (await readJson(join(qualification, 'result.json'), null))?.id, stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopping = true; });
while (!stopping) {
  const command = await readJson(join(qualification, 'command.json'), null);
  if (command && command.id !== last) {
    assert.equal(command.operation, 'stage');
    assert.equal(controller.state.apps.refresh, undefined, 'A recovered installation must never stage another cron approval');
    const selected = await controller.replaceSecrets('refresh', { REFRESH_TOKEN: randomBytes(32).toString('hex') });
    const request = await stageRequest(controller, join(qualification, 'artifact'), async () => {}, { requiredSecrets: ['REFRESH_TOKEN'] });
    await controller.mutate(request.id, request.digest, 'approve', selected.revision);
    assert.equal(request.status, 'active', `Cron activation failed at ${request.step}`);
    await controller.exclusive(() => operateDispatch(controller, 'refresh', 'pause'));
    await saveJson(join(qualification, 'result.json'), { id: command.id, deployment: request.id, digest: request.digest, artifact: controller.artifact(request.id), slot: controller.state.apps.refresh.slot });
    last = command.id;
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
