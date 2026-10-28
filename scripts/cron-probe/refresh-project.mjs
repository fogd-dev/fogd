import { cp, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stackRoot } from '../../packages/cli/src/local.mjs';

// Callers outside the checkout provide their cached application dependencies.
export async function privateRefreshProject(directory) {
  const output = resolve(directory), source = await realpath(join(stackRoot, 'examples/refresh'));
  const root = join(await realpath(dirname(output)), basename(output)), local = relative(source, root);
  if (!(local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))) throw Error('Place private refresh output outside its source fixture');
  await mkdir(root, { mode: 0o700 });
  const project = join(root, 'project'); await mkdir(project, { mode: 0o700 });
  for (const path of ['package.json', 'vite.config.ts', 'void.config.ts', 'fogd.json', 'tsconfig.json', 'env.ts', 'db', 'routes', 'lib']) {
    await cp(join(stackRoot, 'examples/refresh', path), join(project, path), { recursive: true });
  }
  await mkdir(join(project, 'crons'));
  return { root, project };
}
