import { isDeepStrictEqual } from 'node:util';

export { transferFormat, ignoreFiles } from './bootstrap.mjs';
import { transferFormat, validTransferFingerprint } from './bootstrap.mjs';
import { ignoreFiles } from './bootstrap.mjs';
import { operatorGuides } from './guides.mjs';
export const operatorFiles = ['package.json', 'compose.yaml', '.env.example', 'docs/offline-installation.md'];
export function publicProgramPath(path) {
  if (typeof path !== 'string' || path.length > 240 || !/^[A-Za-z0-9@._/-]+$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (operatorFiles.includes(path) || operatorGuides.includes(path)) return true;
  if (['packages/cli/src/preview/storage/host.py', 'packages/cli/src/preview/storage/admission.py', 'packages/cli/src/preview/storage/reconciliation.py', 'packages/cli/src/preview/storage/commands.py'].includes(path)) return true;
  if (/^packages\/(?:cli|platform|runtime)\/package\.json$/.test(path) || path === 'packages/cli/bin/fogd.js') return true;
  if (/^packages\/(?:cli|platform|runtime)\/src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:mjs|js|json)$/.test(path)) return true;
  if (path.startsWith('node_modules/@fogd/')) return publicProgramPath(path.replace('node_modules/@fogd/', 'packages/')) && !path.startsWith('node_modules/@fogd/cli/');
  return ignoreFiles.some(name => path === `node_modules/ignore/${name}`);
}
export function validateTransferManifest(input, entry) {
  if (!input || !isDeepStrictEqual(Object.keys(input).sort(), ['files', 'format', 'runtime']) || input.format !== transferFormat || !isDeepStrictEqual(input.runtime, entry)) throw new Error('Transfer manifest does not match the independently selected qualified runtime');
  const files = input.files;
  if (!files || Array.isArray(files) || Object.keys(files).length > 2048 || !['images.tar', 'verify-transfer.mjs'].every(path => Object.hasOwn(files, path))) throw new Error('Invalid transfer file inventory');
  for (const [path, value] of Object.entries(files)) {
    if (!transferMemberPath(path) || !validTransferFingerprint(value)) throw new Error('Invalid transfer member or fingerprint');
  }
  for (const path of [...operatorFiles, 'packages/cli/bin/fogd.js', 'packages/cli/package.json', 'packages/cli/src/runtime/catalog.json', 'packages/cli/src/distribution/bootstrap.mjs', ...ignoreFiles.map(name => `node_modules/ignore/${name}`)]) {
    if (!Object.hasOwn(files, `program/${path}`)) throw new Error('Required operator program is missing from transfer inventory');
  }
  if (!isDeepStrictEqual(files['verify-transfer.mjs'], files['program/packages/cli/src/distribution/bootstrap.mjs'])) throw new Error('Transfer bootstrap differs from the operator source');
  assertRuntimeSources(files, entry.sourceFiles);
  return structuredClone(input);
}
function transferMemberPath(path) {
  return ['images.tar', 'verify-transfer.mjs'].includes(path) || (path.startsWith('program/') && publicProgramPath(path.slice(8)));
}
export function assertRuntimeSources(files, expected) {
  const actual = Object.keys(files).filter(path => /^program\/packages\/(?:runtime|platform)\//.test(path)).sort();
  if (!isDeepStrictEqual(actual, Object.keys(expected).map(path => `program/${path}`).sort())) throw new Error('Transfer runtime sources differ from the qualified inventory');
  const aliases = Object.keys(files).filter(path => path.startsWith('program/node_modules/@fogd/')).sort();
  if (!isDeepStrictEqual(aliases, actual.map(path => path.replace('program/packages/', 'program/node_modules/@fogd/')).sort())) throw new Error('Transfer package aliases differ from canonical sources');
  for (const [path, sha256] of Object.entries(expected)) {
    const original = files[`program/${path}`], alias = files[`program/${path.replace('packages/', 'node_modules/@fogd/')}`];
    if (original.sha256 !== sha256 || !isDeepStrictEqual(original, alias)) throw new Error('Transfer runtime source or alias fingerprint differs');
  }
}
