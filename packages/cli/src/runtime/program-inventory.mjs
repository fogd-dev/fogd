// Self-contained so the host can execute this same reader in a pinned image,
// without copying a checkout program or mounting installation state into it.
export async function programInventory(root, production = false) {
  const { lstat, readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const files = {};
  async function entries(path) {
    if (!(await lstat(join(root, path))).isDirectory()) throw new Error('Runtime source must be an ordinary directory');
    return (await readdir(join(root, path))).sort();
  }
  function exact(actual, expected) {
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error('Unexpected runtime package entries');
  }
  async function file(path) {
    if (!(await lstat(join(root, path))).isFile()) throw new Error('Runtime source must be a regular file');
    files[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
  }
  async function walk(path) {
    for (const name of await entries(path)) {
      const child = `${path}/${name}`, info = await lstat(join(root, child));
      if (info.isDirectory()) await walk(child);
      else await file(child);
    }
  }
  const packages = await entries('packages');
  if (production) exact(packages, ['platform', 'runtime']);
  for (const name of ['platform', 'runtime']) {
    const path = `packages/${name}`;
    const siblings = await entries(path);
    if (production) exact(siblings, ['node_modules', 'package.json', 'src']);
    await file(`${path}/package.json`); await walk(`${path}/src`);
  }
  if (production) for (const path of ['qualification', 'packages/platform/test', 'packages/runtime/test']) {
    try { await lstat(join(root, path)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Private qualification programs must not be in the product runtime');
  }
  return files;
}
