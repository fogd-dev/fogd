import { join } from 'node:path';
import { Controller } from '../../src/controller.mjs';
import { readJson, saveJson } from '../../src/store.mjs';
import { claimBackend } from './claim-backend.mjs';
const [root, point] = process.argv.slice(2);
const crash = () => process.kill(process.pid, 'SIGKILL');
const state = await readJson(join(root, 'state/state.json'));
const request = Object.values(state.deployments)[0];
const controller = new Controller({
  dir: join(root, 'state'), slots: [{ id: 'slot-1', prefix: 'one', nodes: ['a', 'b'] }],
  backend: claimBackend(root, () => { if (point === 'claimed') crash(); }),
  async persist(path, value) {
    await saveJson(path, value);
    const app = value.apps?.hello;
    if (point === 'intent' && app?.claim) crash();
    if (point === 'confirmed' && app && !app.claim && value.deployments[request.id].step === 'preparing-activation') crash();
  },
});
await controller.init();
await controller.mutate(request.id, request.digest, 'approve');
throw Error('Expected process kill');
