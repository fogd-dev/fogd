import test from 'node:test';
import assert from 'node:assert/strict';
import { startSelectedRuntime } from '../src/runtime/start-installation.mjs';

test('legacy selected runtime retains its pinned no-build no-pull startup command', async () => {
  const calls = [];
  await startSelectedRuntime({ command: ['compose', '-f', '/fixture/compose.json', '-p', 'fixture'], policy: { schema: 2 }, config: { volumes: {} } }, async args => { calls.push(args); });
  assert.deepEqual(calls, [['compose', '-f', '/fixture/compose.json', '-p', 'fixture', 'up', '-d', '--no-build', '--pull', 'never']]);
});
for (const [name, selection] of [
  ['durable profile', { policy: { schema: 3 } }],
  ['durable family', { entry: { routing: 'durable' } }],
  ['durable storage', { config: { volumes: { 'route-authority': {} } } }],
]) test(`${name} cannot use generic all-services startup`, async () => {
  const calls = [];
  await assert.rejects(startSelectedRuntime({ command: [], ...selection }, async args => { calls.push(args); }), { code: 'ROUTE_STARTUP_UNCONFIRMED' });
  assert.deepEqual(calls, []);
});
