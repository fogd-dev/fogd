import { join } from 'node:path';
import { Delivery } from '../../src/delivery.mjs';
import { readJson, saveJson } from '../../src/store.mjs';
const [dir, point, mode] = process.argv.slice(2);
const journal = join(dir, 'delivery.json'), effect = join(dir, 'runtime.json');
function crash() { process.kill(process.pid, 'SIGKILL'); }
const delivery = new Delivery({
  state: await readJson(journal), slot: {},
  async persist(state) {
    await saveJson(journal, state);
    if ((point === 'before-effect' && state.operation === 'resume') || (point === 'after-confirmation' && state.observed === 'running') || (point === 'observe' && state.observed === 'unknown')) crash();
  },
  runtime: {
    async status() { return { paused: true }; },
    async resume(_slot, _name, version) {
      await saveJson(effect, { paused: false, version });
      if (point === 'after-effect') crash();
      return { paused: false };
    },
  },
});
if (point === 'observe') await delivery.observe();
else if (mode === 'activation') await delivery.completeActivation('first', 'v1');
else await delivery.resume();
throw Error('Expected the child to be killed');
