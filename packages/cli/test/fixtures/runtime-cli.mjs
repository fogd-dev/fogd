import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Exercise the real CLI with explicit catalog data, independently of release status.
export async function runtimeCli(root, admission) {
  const directory = join(root, 'cli'), source = fileURLToPath(new URL('../../', import.meta.url));
  await mkdir(directory);
  for (const name of ['src', 'bin', 'package.json']) await cp(join(source, name), join(directory, name), { recursive: true });
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'), 'dir');
  const catalog = join(directory, 'src/runtime/catalog.json');
  const entries = JSON.parse(await readFile(catalog, 'utf8'));
  for (const entry of entries) entry.admission = admission;
  await writeFile(catalog, JSON.stringify(entries));
  return { cli: join(directory, 'bin/fogd.js'), entry: entries[0], catalog,
    module: name => pathToFileURL(join(directory, 'src/runtime', name)).href };
}
