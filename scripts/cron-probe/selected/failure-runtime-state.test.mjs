import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPreparedRuntime } from './failure-runtime-state.mjs';

function snapshot() {
  const replicas = ['owner', 'peer'].map(node => ({ node, state: { quiescing: 0, evicting: 0, releasing: 0, adopting: 0, restoring: 0,
    residents: node === 'owner' ? ['.cron:refresh'] : [], deployment: { version: 'release', swapping: 0, generation: 4, cells: node === 'owner' ? { '.cron:refresh': 4 } : {} } } }));
  return { bucket: { owner: { node: 'owner', epoch: 7 } }, replicas };
}
test('paused preparation requires a resident cron and idle handoff machinery', () => {
  assert.doesNotThrow(() => assertPreparedRuntime(snapshot(), 'owner', 7, 'release'));
});
for (const [name, mutate] of [
  ['pending peer adoption', value => { value.replicas[1].state.adopting = 1; }],
  ['dormant cron', value => { value.replicas[0].state.residents = []; }],
  ['stale cron generation', value => { value.replicas[0].state.deployment.cells['.cron:refresh'] = 3; }],
  ['another release', value => { value.replicas[1].state.deployment.version = 'other'; }],
  ['changed ownership epoch', value => { value.bucket.owner.epoch = 8; }],
  ['unavailable replica', value => { value.replicas[1] = { node: 'peer', error: { name: 'TimeoutError' } }; }],
  ['duplicate replica identity', value => { value.replicas[1].node = 'owner'; }],
  ['malformed counter', value => { value.replicas[1].state.releasing = '0'; }],
]) test(`paused preparation refuses ${name}`, () => {
  const value = snapshot(); mutate(value); assert.throws(() => assertPreparedRuntime(value, 'owner', 7, 'release'));
});
