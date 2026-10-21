// Code and expected identity live in the image; only commands/artifacts/results
// travel in controller data. A restored consumed command cannot approve again.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { guardedBackend, qualificationPolicy } from './backend.mjs';
import { stageRequest } from './controller-artifact.mjs';
import { startController } from '/app/packages/platform/src/startup.mjs';
import { operateDispatch } from '/app/packages/platform/src/admin-dispatch.mjs';
import { readJson, saveJson } from '/app/packages/platform/src/store.mjs';
import { artifactDigest } from '/app/packages/runtime/src/artifact.mjs';

const directory = '/var/lib/fogd/qualification';
const { expectedArtifactSha256 } = await qualificationPolicy();
assert.match(expectedArtifactSha256, /^[a-f0-9]{64}$/);
const { controller } = await startController(await guardedBackend(), { cronApps: true });
let consumed = (await readJson(join(directory, 'result.json'), null))?.id, stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopping = true; });
while (!stopping) {
  const command = await readJson(join(directory, 'command.json'), null);
  if (command && command.id !== consumed) {
    assert.equal(command.operation, 'stage');
    assert.equal(controller.state.apps.refresh, undefined, 'A recovered installation must never stage another approval');
    assert.equal(await artifactDigest(join(directory, 'artifact')), expectedArtifactSha256, 'Fixture artifact differs before staging');
    const request = await stageRequest(controller, join(directory, 'artifact'), async () => {}, { requiredSecrets: ['REFRESH_TOKEN'] });
    assert.equal(request.digest, expectedArtifactSha256, 'Only the image-pinned fixture artifact may be approved');
    const selected = await controller.replaceSecrets('refresh', { REFRESH_TOKEN: randomBytes(32).toString('hex') });
    await controller.mutate(request.id, request.digest, 'approve', selected.revision);
    assert.equal(request.status, 'active', `Cron activation failed at ${request.step}`);
    await controller.exclusive(() => operateDispatch(controller, 'refresh', 'pause'));
    await saveJson(join(directory, 'result.json'), { id: command.id, deployment: request.id, digest: request.digest,
      artifact: controller.artifact(request.id), slot: controller.state.apps.refresh.slot });
    consumed = command.id;
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
