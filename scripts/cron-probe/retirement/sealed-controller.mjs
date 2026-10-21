import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { guardedBackend, qualificationPolicy } from './backend.mjs';
import { retirementStage, retirementVariant, runtimeVariantName, assertRetirementHistory } from './retirement-policy.mjs';
import { stageRequest } from './controller-artifact.mjs';
import { startController } from '/app/packages/platform/src/startup.mjs';
import { operateDispatch } from '/app/packages/platform/src/admin-dispatch.mjs';
import { readJson, saveJson } from '/app/packages/platform/src/store.mjs';
import { artifactDigest } from '/app/packages/runtime/src/artifact.mjs';
import { waitForMinuteBoundary } from './minute.mjs';

assert.deepEqual(process.execArgv, []); assert.equal(process.env.NODE_OPTIONS, undefined);
assert.deepEqual(process.argv, ['/usr/local/bin/node', '/app/qualification/controller.mjs']);
const policy = await qualificationPolicy(), slots = JSON.parse(process.env.FOGD_SLOTS);
const variant = runtimeVariantName(policy, slots), selected = retirementVariant(policy, variant);
assert.deepEqual(selected.controllerArgs, ['/app/qualification/controller.mjs']);
const directory = '/var/lib/fogd/qualification', backend = await guardedBackend();
const bootstrap = backend.bootstrap.bind(backend);
backend.bootstrap = async (slot, artifact, resources) => {
  const version = await bootstrap(slot, artifact, resources);
  if (resources.crons) {
    await backend.ready(slot, version);
    const control = await backend.crons.status(slot, resources.script);
    assert.deepEqual(control, { paused: true, revision: 0, nextAlarm: null, crons: [] });
    await saveJson(join(directory, `${resources.script}-bootstrap.json`), { slot: slot.id, control });
  }
  return version;
};
assertRetirementHistory(policy, variant, await readJson('/var/lib/fogd/state.json', { apps: {} }));
const { controller } = await startController(backend);
let consumed = (await readJson(join(directory, 'result.json'), null))?.id, stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopping = true; });
while (!stopping) {
  const command = await readJson(join(directory, 'command.json'), null);
  if (command && command.id !== consumed) {
    try {
      const input = retirementStage(policy, variant, command);
      assert.equal(controller.state.apps[input.name], undefined, 'Never restage an existing or retired app');
      assert.equal(await artifactDigest(input.source), input.digest);
      const request = await stageRequest(controller, input.source, async () => {}, { requiredSecrets: ['REFRESH_TOKEN'] });
      assert.equal(request.digest, input.digest);
      if (input.name === 'refresh') {
        const secret = await controller.replaceSecrets(input.name, { REFRESH_TOKEN: randomBytes(32).toString('hex') });
        const boundary = await waitForMinuteBoundary(); assert.equal(await backend.hasDeployment(slots[0]), false);
        await controller.mutate(request.id, request.digest, 'approve', secret.revision);
        assert.equal(request.status, 'active', `Cron activation failed at ${request.step}`);
        await controller.exclusive(() => operateDispatch(controller, input.name, 'pause'));
        await saveJson(join(directory, 'preapproval.json'), { boundary, noDeploymentBeforeApproval: true });
      } else {
        await assert.rejects(controller.mutate(request.id, request.digest, 'approve'), /Select the current secret revision/);
        assert.equal(request.status, 'pending'); assert.equal(controller.state.apps[input.name], undefined);
      }
      await saveJson(join(directory, 'result.json'), { id: command.id, deployment: request.id, digest: request.digest,
        artifact: controller.artifact(request.id), slot: controller.state.apps[input.name]?.slot || null, missingSecretRefused: input.name === 'scheduled-next' });
      consumed = command.id;
    } catch (error) {
      await saveJson(join(directory, 'failure.json'), { message: error.message, stack: error.stack }); throw error;
    }
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
