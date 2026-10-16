import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import ignore from 'ignore';
import { copyFiles } from './files.mjs';

// Materialize Void/Wrangler's gitignore-style exclusions before celld uploads
// the tree. Keep _headers and _redirects for celld's own metadata parser.
export async function stageAssets(source, destination, files) {
  const privateFiles = ignore().add(['.DS_Store', '.env', '.env.*', '.dev.vars', '.dev.vars.*']);
  const ignored = ignore();
  if (files.includes('.assetsignore')) ignored.add(await readFile(join(source, '.assetsignore'), 'utf8'));
  const publicFiles = files.filter(file => {
    const path = file.replaceAll('\\', '/');
    const metadata = path === '_headers' || path === '_redirects';
    return path !== '.assetsignore' && !privateFiles.ignores(path) && (metadata || !ignored.ignores(path));
  });
  await copyFiles(source, destination, publicFiles);
}
