// Read-only comparison of the first retained source and the zero-live restored target.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { composeArgs, projectContainers, stopped, volumeNames } from '../../packages/cli/src/recovery/docker.mjs';
import { execute } from '../../packages/cli/src/recovery/execute.mjs';
import { prefixFingerprints } from './prefix-fingerprints.mjs';
const [sourceArg, targetArg, prefix, outputArg] = process.argv.slice(2);
const output = resolve(outputArg); await mkdir(output, { mode: 0o700 });
const sourceFile = resolve(sourceArg), targetFile = resolve(targetArg);
const source = JSON.parse(await readFile(sourceFile)), target = JSON.parse(await readFile(targetFile));
for (const config of [source, target]) assert.match(config.name, /^fogd-m11[a-z0-9-]*$/);
assert.notEqual(source.name, target.name);
assert.ok(JSON.parse(source.services.controller.environment.FOGD_SLOTS).some(slot => slot.prefix === prefix));
assert.ok(!JSON.parse(target.services.controller.environment.FOGD_SLOTS).some(slot => slot.prefix === prefix));
await stopped(source.name, volumeNames(source).map(name => source.volumes[name].name));
const compose = (file, project) => args => execute('docker', [...composeArgs(file, project), ...args]);
const sourceCompose = compose(sourceFile, source.name), targetCompose = compose(targetFile, target.name);
let original;
try {
  await sourceCompose(['up', '-d', '--no-deps', 'minio']);
  original = await prefixFingerprints(sourceCompose, prefix, false);
} finally { await sourceCompose(['stop', 'minio']); }
assert.ok(original.length > 0);
assert.deepEqual(await prefixFingerprints(targetCompose, prefix, true), original);
const containers = await projectContainers(target.name);
const states = containers.map(container => ({ service: container.Config.Labels['com.docker.compose.service'], running: container.State.Running, exitCode: container.State.ExitCode, restartCount: container.RestartCount }));
assert.deepEqual(states.map(s => s.service).sort(), Object.keys(target.services).sort());
for (const state of states) {
  assert.equal(state.running, state.service !== 'bucket-init');
  assert.equal(state.exitCode, 0); assert.equal(state.restartCount, 0);
}
await writeFile(join(output, 'inspection.json'), JSON.stringify({ source: source.name, target: target.name, prefix, sourceAndRestoredObjects: original, containerStates: states, sourceWritersStopped: true }, null, 2) + '\n', { mode: 0o600 });
console.log('PASS: original retired prefix matches stopped source; all target services have expected state and zero restarts');
