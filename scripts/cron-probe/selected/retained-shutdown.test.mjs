import test from 'node:test';
import assert from 'node:assert/strict';
import { stopRetainedContainers } from './retained-shutdown.mjs';

function fixture() {
  return ['minio', 'slot-1-b', 'workerd', 'bucket-init', 'controller', 'slot-1-a'].map((service, index) => ({
    Id: String(index + 1).repeat(64), Config: { Labels: { 'com.docker.compose.project': 'owned', 'com.docker.compose.service': service } },
  }));
}

test('retained shutdown stops ingress and controller before native nodes, then storage, without removal', async () => {
  const containers = fixture(), commands = [], running = new Set(containers.map(c => c.Id));
  await stopRetainedContainers('owned', containers, async args => {
    commands.push(args); assert.equal(args[0], 'stop');
    for (const id of args.slice(1)) running.delete(id);
  });
  assert.equal(running.size, 0);
  assert.deepEqual(commands, [
    ['stop', containers[2].Id], ['stop', containers[4].Id],
    ['stop', containers[1].Id, containers[5].Id], ['stop', containers[0].Id, containers[3].Id],
  ]);
});

test('uncertain native stop leaves storage running and propagates the exact error', async () => {
  const containers = fixture(), commands = [], failure = new Error('native stop unconfirmed'), running = new Set(containers.map(c => c.Id));
  await assert.rejects(stopRetainedContainers('owned', containers, async args => {
    commands.push(args); if (args.includes(containers[1].Id)) throw failure;
    assert.equal(args[0], 'stop'); for (const id of args.slice(1)) running.delete(id);
  }), error => error === failure);
  assert.deepEqual(running, new Set([containers[0].Id, containers[1].Id, containers[3].Id, containers[5].Id]));
  assert.deepEqual(commands, [['stop', containers[2].Id], ['stop', containers[4].Id], ['stop', containers[1].Id, containers[5].Id]]);
});

for (const [name, mutate] of [
  ['foreign project', c => { c[0].Config.Labels['com.docker.compose.project'] = 'other'; }],
  ['unknown service', c => { c[0].Config.Labels['com.docker.compose.service'] = 'unrelated'; }],
  ['duplicate resource', c => { c[0].Id = c[1].Id; }],
  ['duplicate service', c => { c[0].Config.Labels['com.docker.compose.service'] = 'slot-1-a'; }],
  ['malformed container ID', c => { c[0].Id = 'not-an-id'; }],
]) test(`retained shutdown refuses ${name} before stopping anything`, async () => {
  const containers = fixture(), commands = []; mutate(containers);
  const running = new Set(containers.map(c => c.Id)), original = new Set(running);
  await assert.rejects(stopRetainedContainers('owned', containers, async args => {
    commands.push(args); for (const id of args.slice(1)) running.delete(id);
  }), { code: 'ERR_ASSERTION' });
  assert.deepEqual(running, original);
  assert.deepEqual(commands, []);
});
