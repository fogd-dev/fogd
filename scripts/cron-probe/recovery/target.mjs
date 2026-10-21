import assert from 'node:assert/strict';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { composeArgs, projectContainers } from '../../../packages/cli/src/recovery/docker.mjs';

export async function requireFreshTarget(project, directory, config) {
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
  await requireFreshResources(project, config);
}
export async function requireFreshResources(project, config) {
  assert.equal((await projectContainers(project)).length, 0, 'Target already has containers; cleanup ownership was not acquired');
  for (const [kind, field] of [['volume', 'volumes'], ['network', 'networks']]) {
    assert.equal((await execute('docker', [kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])).trim(), '', 'Target already owns resources');
    const names = new Set((await execute('docker', [kind, 'ls', '--format', '{{.Name}}'])).trim().split('\n'));
    for (const key of Object.keys(config[field])) assert.ok(!names.has(`${project}_${key}`), 'Target resource name already exists');
  }
}
export async function cleanupNewTarget(project, directory, config) {
  let created = false;
  for (const name of ['compose.json', 'compose.pending.json']) {
    try { await readFile(join(directory, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    created = true; await execute('docker', [...composeArgs(join(directory, name), project), 'down']); break;
  }
  assert.equal((await projectContainers(project)).length, 0);
  assert.equal((await execute('docker', ['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])).trim(), '');
  const volumes = (await execute('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`])).trim().split('\n').filter(Boolean).sort();
  const expected = Object.keys(config.volumes).map(name => `${project}_${name}`).sort();
  assert.deepEqual(volumes, created ? expected : [], 'Partial target cleanup must preserve every created volume');
}
