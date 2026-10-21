import { Controller } from '../../src/controller.mjs';
import { saveJson } from '../../src/store.mjs';
import { cronBackend } from './cron-backend.mjs';
import { slots } from './cron-controller.mjs';
const [dir, id, point] = process.argv.slice(2);
const crash = () => process.kill(process.pid, 'SIGKILL');
const backend = cronBackend(dir, event => { if (point === `effect:${event}`) crash(); });
const c = new Controller({ cronApps: true, dir, slots, backend,
  async persist(path, value) {
    await saveJson(path, value);
    const request = value.deployments?.[id];
    if (point === 'released' && request?.step === 'releasing-dispatch' && value.apps.refresh.dispatch.hold === null) crash();
    if (point === 'application-intent' && request?.step === 'cron-application-intent') crash();
  },
});
await c.init();
await c.mutate(id, c.state.deployments[id].digest, 'approve');
throw Error('Expected controller process to be killed');
