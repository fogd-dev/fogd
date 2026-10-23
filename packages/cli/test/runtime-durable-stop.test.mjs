import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stopDurableInstallation } from '../src/runtime/durable-stop.mjs';
import { acquireLaunchFence } from '../src/runtime/launch-fence.mjs';
import { freshRuntimePlan } from '../src/runtime/selection-plan.mjs';
import { runtimeFamilies } from '../src/runtime/catalog.mjs';
import { prebootFixture } from './fixtures/cron-preboot.mjs';

async function fixture(t) {
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
const nameOf = container => container.Config.Labels['com.docker.compose.service'];
const marker = f => join(f.directory, 'launch.pending.json');
const uncertain = work => assert.rejects(work, error => error.code === 'ROUTE_STOP_UNCONFIRMED' && !/private|sha256|original_/.test(error.message) && !error.cause);

test('durable shutdown stops inspected IDs with verified ingress first and preserves all storage', async t => {
  const f = await fixture(t), before = structuredClone(f.engine);
  const report = await stopDurableInstallation(f.config, f.options);
  const byId = id => before.containers.find(container => container.Id === id);
  assert.deepEqual(f.calls.map(args => args.slice(1).map(id => nameOf(byId(id)))), [
    ['workerd'], ['controller'], ['slot-1-a', 'slot-1-b', 'slot-2-a', 'slot-2-b'], ['minio']]);
  assert.equal(f.observations[1].find(container => nameOf(container) === 'workerd').State.Running, false);
  assert.equal(f.observations[1].find(container => nameOf(container) === 'controller').State.Running, true);
  assert.equal(report.status, 'stopped'); assert.equal(report.backupCreated, false); assert.equal(report.durability, 'not-assessed');
  assert.deepEqual(report.retainedVolumes, before.volumes); assert.deepEqual(report.missingVolumes, []);
  assert.deepEqual(f.engine.volumes, before.volumes); assert.deepEqual(await readdir(f.directory), []);
  assert.deepEqual(await stopDurableInstallation(f.config, f.options), report); assert.equal(f.calls.length, 4);
});
test('incomplete enrollment and missing resources can be stopped without repairing records or storage', async t => {
  const f = await fixture(t), pending = join(f.directory, 'enrollment.pending.json'); await writeFile(pending, 'incomplete');
  f.engine.volumes = f.engine.volumes.filter(name => name !== 'original_bucket');
  f.engine.containers = f.engine.containers.filter(container => nameOf(container) !== 'minio');
  const report = await stopDurableInstallation(f.config, f.options);
  assert.deepEqual(report.missingVolumes, ['original_bucket']); assert.equal(report.services.length, 7);
  assert.equal(await readFile(pending, 'utf8'), 'incomplete'); assert.deepEqual(await readdir(f.directory), ['enrollment.pending.json']);
});
test('an existing startup fence prevents any shutdown mutation', async t => {
  const f = await fixture(t), fence = await acquireLaunchFence(f.directory, { project: f.config.name, installation: 'fixture' });
  const before = await readFile(marker(f)); await uncertain(stopDurableInstallation(f.config, f.options));
  assert.deepEqual(f.calls, []); assert.deepEqual(await readFile(marker(f)), before); await fence.release();
});
test('invalid or unrecognized durable plans cannot reach Docker or acquire an operation marker', async t => {
  for (const mutate of [f => { f.options.families = () => []; }, f => { f.config.services.workerd.environment.EXTRA = 'private'; },
    f => { f.config.services.controller.image = 'sha256:' + 'f'.repeat(64); }]) {
    const f = await fixture(t); mutate(f); f.options.containers = async () => assert.fail('No Docker reads');
    await uncertain(stopDurableInstallation(f.config, f.options)); assert.deepEqual(await readdir(f.directory), []);
  }
});
test('foreign or unreadable project container identity refuses without mutation and releases only its checking fence', async t => {
  for (const mutate of [container => { container.Id = 'short'; }, container => { container.Config.Labels['com.docker.compose.project'] = 'foreign'; },
    container => { container.Config.Labels['com.docker.compose.oneoff'] = 'True'; }, container => { delete container.State.Running; }]) {
    const f = await fixture(t); mutate(f.engine.containers[0]); await uncertain(stopDurableInstallation(f.config, f.options));
    assert.deepEqual(f.calls, []); assert.deepEqual(await readdir(f.directory), []);
  }
});
test('a failed first stop retains the fence and never reports stopped', async t => {
  const f = await fixture(t); f.options.run = async args => { f.calls.push(args); throw new Error('private Docker failure'); };
  await uncertain(stopDurableInstallation(f.config, f.options)); assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(await readFile(marker(f))).phase, 'stopping');
  await uncertain(stopDurableInstallation(f.config, f.options)); assert.equal(f.calls.length, 1);
});
test('surviving ingress refuses before stopping controller or replicas', async t => {
  const f = await fixture(t); f.options.run = async args => { f.calls.push(args); };
  await uncertain(stopDurableInstallation(f.config, f.options)); assert.equal(f.calls.length, 1);
  assert.equal(f.engine.containers.find(container => nameOf(container) === 'controller').State.Running, true);
  assert.equal(JSON.parse(await readFile(marker(f))).phase, 'stopping');
});
test('a replaced container after the ingress command cannot receive further stop commands', async t => {
  const f = await fixture(t), run = f.options.run;
  f.options.run = async args => { await run(args); f.engine.containers.find(container => nameOf(container) === 'controller').Id = 'e'.repeat(64); };
  await uncertain(stopDurableInstallation(f.config, f.options)); assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(await readFile(marker(f))).phase, 'stopping');
});
test('foreign writers or disappearing storage cannot produce a successful stopped report', async t => {
  for (const alter of [f => { f.options.stopped = async () => { throw new Error('private writer'); }; },
    f => { const run = f.options.run; f.options.run = async args => { await run(args); f.engine.volumes = []; }; }]) {
    const f = await fixture(t); alter(f); await uncertain(stopDurableInstallation(f.config, f.options));
    assert.equal(JSON.parse(await readFile(marker(f))).phase, 'stopping');
  }
});
test('uncertain fence release after verified shutdown cannot make further Docker mutations', async t => {
  const f = await fixture(t); let phase;
  f.options.acquire = async () => ({ record: async value => { phase = value; }, release: async () => { throw new Error('private release'); } });
  await uncertain(stopDurableInstallation(f.config, f.options)); assert.equal(phase, 'complete'); assert.equal(f.calls.length, 4);
  assert.ok(f.engine.containers.every(container => !container.State.Running));
});
