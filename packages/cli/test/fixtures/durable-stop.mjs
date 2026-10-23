import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshRuntimePlan } from '../../src/runtime/selection-plan.mjs';
import { runtimeFamilies } from '../../src/runtime/catalog.mjs';
import { prebootFixture } from './cron-preboot.mjs';

export async function durableStopFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-durable-stop-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'host'); await mkdir(directory, { mode: 0o700 });
  const { source, profile } = prebootFixture();
  const entry = { ...runtimeFamilies()[0], schema: 2, routing: 'durable', image: profile.image, storageImage: profile.storageImage,
    binarySha256: profile.binarySha256, supervisorSha256: profile.supervisorSha256 };
  const { config, policy } = freshRuntimePlan(source, entry);
  const engine = { volumes: Object.values(config.volumes).map(volume => volume.name).sort(),
    containers: Object.entries(config.services).map(([name, service], i) => ({ Id: i.toString(16).padStart(64, 'a'), Image: service.image,
      Config: { Labels: { 'com.docker.compose.project': config.name, 'com.docker.compose.service': name, 'com.docker.compose.oneoff': 'False' } },
      State: { Running: name !== 'bucket-init', Restarting: false, Paused: false, Status: name === 'bucket-init' ? 'exited' : 'running', ExitCode: 0, OOMKilled: false } })) };
  const calls = [], observations = [], options = { directory, families: () => [entry], volumes: async () => [...engine.volumes],
    containers: async project => { assert.equal(project, config.name); observations.push(structuredClone(engine.containers)); return structuredClone(engine.containers); },
    run: async args => {
      calls.push(args); assert.equal(args[0], 'stop');
      for (const id of args.slice(1)) {
        const container = engine.containers.find(value => value.Id === id); assert.ok(container);
        container.State.Running = false; container.State.Status = 'exited';
      }
    },
    stopped: async (project, names) => { assert.equal(project, config.name); assert.deepEqual(names.sort(), Object.values(config.volumes).map(volume => volume.name).sort()); assert.ok(engine.containers.every(container => !container.State.Running)); } };
  return { root, directory, config, policy, engine, calls, observations, options };
}
