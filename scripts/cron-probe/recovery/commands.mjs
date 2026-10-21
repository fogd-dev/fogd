// Private runner: commands are consumed once across controller archive restores.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Backend } from '/app/packages/platform/src/backend.mjs';
import { CronRuntime } from '/app/packages/platform/src/cron-runtime.mjs';
import { startController } from '/app/packages/platform/src/startup.mjs';
import { readJson, saveJson } from '/app/packages/platform/src/store.mjs';

export async function runCommands({ project, decorate = () => {}, stage }) {
  assert.match(process.env.COMPOSE_PROJECT_NAME || '', project);
  const qualification = '/var/lib/fogd/qualification', backend = new Backend();
  backend.crons = new CronRuntime({ run: (slot, args) => backend.run(slot, args), inspect: node => backend.deployment(node) });
  decorate(backend, qualification);
  const { controller } = await startController(backend, { cronApps: true });
  let last = (await readJson(join(qualification, 'result.json'), null))?.id, stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopping = true; });
  while (!stopping) {
    const command = await readJson(join(qualification, 'command.json'), null);
    if (command && command.id !== last) {
      assert.equal(command.operation, 'stage');
      const result = await stage(controller, qualification, command);
      await saveJson(join(qualification, 'result.json'), { id: command.id, ...result });
      last = command.id;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
