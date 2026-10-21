// Private qualification: the new app must supply independent configuration.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { operateDispatch } from '/app/packages/platform/src/admin-dispatch.mjs';
import { saveJson } from '/app/packages/platform/src/store.mjs';
import { stageRequest } from './controller-artifact.mjs';
import { runCommands } from './commands.mjs';

await runCommands({ project: /^fogd-m11c-cron-retirement-/,
  decorate(backend, qualification) {
    const bootstrap = backend.bootstrap.bind(backend);
    backend.bootstrap = async (slot, artifact, resources) => {
      const version = await bootstrap(slot, artifact, resources);
      if (resources.crons) {
        await backend.ready(slot, version);
        const control = await backend.crons.status(slot, resources.script);
        assert.equal(control.paused, true); assert.equal(control.revision, 0); assert.equal(control.nextAlarm, null);
        await saveJson(join(qualification, `${resources.script}-bootstrap.json`), { slot: slot.id, control });
      }
      return version;
    };
  },
  async stage(controller, qualification, command) {
    const name = command.app || 'refresh';
    assert.ok(['refresh', 'scheduled-next'].includes(name));
    assert.equal(controller.state.apps[name], undefined, 'Never restage a recovered or retired app');
    const request = await stageRequest(controller, join(qualification, 'artifact'), async (_, config) => { config.name = name; }, { requiredSecrets: ['REFRESH_TOKEN'] });
    if (name === 'refresh') {
      const selected = await controller.replaceSecrets(name, { REFRESH_TOKEN: randomBytes(32).toString('hex') });
      await controller.mutate(request.id, request.digest, 'approve', selected.revision);
      assert.equal(request.status, 'active', `Cron activation failed at ${request.step}`);
      await controller.exclusive(() => operateDispatch(controller, name, 'pause'));
    } else {
      await assert.rejects(controller.mutate(request.id, request.digest, 'approve'), /Select the current secret revision/);
      assert.equal(request.status, 'pending'); assert.equal(controller.state.apps[name], undefined);
    }
    return { deployment: request.id, digest: request.digest, artifact: controller.artifact(request.id), slot: controller.state.apps[name]?.slot || null, missingSecretRefused: name === 'scheduled-next' };
  },
});
