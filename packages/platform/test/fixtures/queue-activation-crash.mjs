import { Controller } from '../../src/controller.mjs';
import { saveJson } from '../../src/store.mjs';
import { queueBackend } from './queue-backend.mjs';
const [dir, id, point] = process.argv.slice(2);
const crash = () => process.kill(process.pid, 'SIGKILL');
const backend = queueBackend(dir, event => { if (point === `effect:${event}`) crash(); });
const c = new Controller({ queueApps: true, dir, slots: [{ id: 'one', prefix: 'one', nodes: ['a', 'b'] }], backend,
  async persist(path, value) {
    await saveJson(path, value);
    const request = value.deployments?.[id];
    if (point === 'released' && request?.step === 'releasing-delivery' && value.apps.imports.delivery.hold === null) crash();
    if (point === 'application-intent' && request?.step === 'queue-application-intent') crash();
  },
});
await c.init();
await c.mutate(id, c.state.deployments[id].digest, 'approve');
throw Error('Expected controller process to be killed');
