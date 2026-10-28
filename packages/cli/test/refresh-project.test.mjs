import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateRefreshProject } from '../../../scripts/cron-probe/refresh-project.mjs';
import { stackRoot } from '../src/local.mjs';

test('refresh qualification can copy public fixture inputs outside the checkout without replacing prior output', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'fogd-refresh-project-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const { root, project } = await privateRefreshProject(join(parent, 'private'));
  assert.equal(root, join(await realpath(parent), 'private'));
  assert.equal(await readFile(join(project, 'env.ts'), 'utf8'), await readFile(join(stackRoot, 'examples/refresh/env.ts'), 'utf8'));
  await assert.rejects(privateRefreshProject(root), { code: 'EEXIST' });
});

test('refresh qualification refuses its public source as output', async () => {
  await assert.rejects(privateRefreshProject(join(stackRoot, 'examples/refresh')), /outside its source fixture/);
});
