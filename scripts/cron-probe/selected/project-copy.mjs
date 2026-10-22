import assert from 'node:assert/strict';
import { mkdir, symlink, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const repo = fileURLToPath(new URL('../../../', import.meta.url));

export async function copyFixture(host, name, directory = name) {
  const project = join(host.output, `${directory}-source`); await mkdir(project);
  const prefix = `examples/${name}/`, execute = promisify(execFile);
  const tracked = (await execute('git', ['ls-files', '-z', '--', `examples/${name}`], { cwd: repo })).stdout.split('\0').filter(Boolean);
  assert.ok(tracked.length > 0);
  for (const path of tracked) {
    const target = join(project, path.slice(prefix.length));
    await mkdir(dirname(target), { recursive: true }); await copyFile(join(repo, path), target);
  }
  await symlink(join(repo, `examples/${name}/node_modules`), join(project, 'node_modules'), 'dir');
  return project;
}
