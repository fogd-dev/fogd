import { cp, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { stackRoot } from '../../packages/cli/src/local.mjs';

// Private copies stay under this checkout so ordinary builds resolve pinned deps.
export async function privateRefreshProject(directory) {
  const root = resolve(directory), local = relative(join(stackRoot, '.fogd'), root);
  if (!local || local.startsWith('..') || isAbsolute(local)) throw Error('Place refresh evidence inside this checkout’s .fogd directory to use pinned build dependencies');
  await mkdir(root, { mode: 0o700 });
  const project = join(root, 'project'); await mkdir(project, { mode: 0o700 });
  for (const path of ['package.json', 'vite.config.ts', 'void.config.ts', 'fogd.json', 'tsconfig.json', 'env.ts', 'db', 'routes', 'lib']) {
    await cp(join(stackRoot, 'examples/refresh', path), join(project, path), { recursive: true });
  }
  await mkdir(join(project, 'crons'));
  return { root, project };
}
