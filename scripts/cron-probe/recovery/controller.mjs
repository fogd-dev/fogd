// Private full-installation qualification; archived commands cannot restage apps.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { operateDispatch } from '/app/packages/platform/src/admin-dispatch.mjs';
import { stageRequest } from './controller-artifact.mjs';
import { runCommands } from './commands.mjs';

await runCommands({ project: /^fogd-m11c-cron-recovery/,
  async stage(controller, qualification) {
    assert.equal(controller.state.apps.refresh, undefined, 'A recovered installation must never stage another cron approval');
    const selected = await controller.replaceSecrets('refresh', { REFRESH_TOKEN: randomBytes(32).toString('hex') });
    const request = await stageRequest(controller, join(qualification, 'artifact'), async () => {}, { requiredSecrets: ['REFRESH_TOKEN'] });
    await controller.mutate(request.id, request.digest, 'approve', selected.revision);
    assert.equal(request.status, 'active', `Cron activation failed at ${request.step}`);
    await controller.exclusive(() => operateDispatch(controller, 'refresh', 'pause'));
    return { deployment: request.id, digest: request.digest, artifact: controller.artifact(request.id), slot: controller.state.apps.refresh.slot };
  },
});
