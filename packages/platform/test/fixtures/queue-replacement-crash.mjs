import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../src/controller.mjs';
import { saveJson } from '../../src/store.mjs';
import { queueBackend } from './queue-backend.mjs';
const [dir, candidate, held, digest, point] = process.argv.slice(2);
const crash = () => process.kill(process.pid, 'SIGKILL');
const backend = queueBackend(dir, event => {
  if (event === 'pause' && point === 'effect' && JSON.parse(readFileSync(join(dir, 'state.json'))).apps.imports.delivery.hold === candidate) crash();
});
const c = new Controller({ dir, slots: [{ id: 'one', prefix: 'one', nodes: ['a', 'b'] }], backend,
  async persist(path, state) {
    const transfer = state.deployments?.[candidate]?.step === 'transferring-delivery-hold' && state.apps.imports.delivery.hold === candidate;
    if (transfer && point === 'before') crash();
    await saveJson(path, state);
    if (point === 'reconciled' && state.apps?.imports?.uncertain === null && state.apps.imports.migrations.length === 1 && state.deployments[candidate].status === 'pending') crash();
    if (transfer && point === 'intent' && state.apps.imports.delivery.operation === 'pause') crash();
    if (transfer && point === 'confirmed' && state.apps.imports.delivery.operation === null) crash();
  },
});
await c.init();
await c.mutate(candidate, c.state.deployments[candidate].digest, 'approve', undefined, { deployment: held, digest });
throw Error('Expected replacement process to be killed');
