import assert from 'node:assert/strict';
import { join, posix } from 'node:path';
import { execute } from '../../../packages/cli/src/recovery/execute.mjs';
import { volumeHelper } from '../../../packages/cli/src/recovery/volumes.mjs';

export function archivedPrefixPaths(listing, bucket, prefix) {
  for (const name of [bucket, prefix]) assert.ok(typeof name === 'string' && name.length > 0 && !name.startsWith('/') && !name.split('/').some(part => ['', '.', '..'].includes(part)));
  const root = `${bucket}/${prefix}`;
  const paths = listing.trimEnd().split('\n').map(name => name.replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(name => name === root || name.startsWith(root + '/')).sort();
  assert.ok(paths.length > 1 && paths.includes(root), 'Retired prefix must have archived contents');
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.every(name => posix.normalize(name) === name));
  return { root, paths };
}

export async function assertArchivedPrefix(target, point, prefix) {
  const archive = join(point.bundle, 'bucket.tar');
  const expected = archivedPrefixPaths(await execute('tar', ['-tf', archive]), target.policy.bucket, prefix);
  const code = `import{readdir,lstat}from'node:fs/promises';const names=[];async function visit(key){names.push(key);if((await lstat('/data/'+key)).isDirectory())for(const child of await readdir('/data/'+key))await visit(key+'/'+child);}await visit(${JSON.stringify(expected.root)});console.log(JSON.stringify(names.sort()));`;
  const volume = target.config.volumes.bucket.name;
  const actual = JSON.parse(await volumeHelper(target.entry.image, volume, ['node', '--input-type=module', '-e', code]));
  assert.deepEqual(actual, expected.paths, 'Restored retired namespace has added or missing entries');
  await volumeHelper(target.entry.image, volume, ['tar', '--numeric-owner', '-C', '/data', '--compare', '-pf', '-', '--', `./${expected.root}/`], { input: archive });
  return { prefix, archiveEntriesCompared: expected.paths.length, exactNamesCompared: true };
}
