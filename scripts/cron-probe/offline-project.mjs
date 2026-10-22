import { cp, mkdir, readFile, stat, chmod, readdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { regularFiles } from '../../packages/runtime/src/artifact.mjs';

const inputs = ['package.json', 'vite.config.ts', 'void.config.ts', 'fogd.json', 'tsconfig.json', 'env.ts', 'db', 'routes', 'lib', 'crons'];
export async function offlineSourceHashes(source) {
  const hashes = {};
  for (const path of inputs) {
    const files = (await stat(join(source, path))).isDirectory() ? (await regularFiles(join(source, path))).map(file => `${path}/${file}`) : [path];
    for (const file of files) hashes[file] = createHash('sha256').update(await readFile(join(source, file))).digest('hex');
  }
  return hashes;
}
export async function copyOfflineProject(source, project) {
  await mkdir(dirname(project), { recursive: true }); await mkdir(project);
  for (const path of inputs) await cp(join(source, path), join(project, path), { recursive: true });
  await symlink('/app/examples/refresh/node_modules', join(project, 'node_modules'), 'dir');
  return project;
}
export async function readableOfflineOutput(path, modes = { directory: 0o755, file: 0o644 }) {
  const info = await stat(path); await chmod(path, info.isDirectory() ? modes.directory : modes.file);
  if (info.isDirectory()) for (const name of await readdir(path)) await readableOfflineOutput(join(path, name), modes);
}
