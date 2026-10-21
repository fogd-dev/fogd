import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { programInventory } from '../src/runtime/program-inventory.mjs';
import { validateRuntimeFamily, verifyRuntimeFamily, runtimeFamily, selectFamily } from '../src/runtime/catalog.mjs';

const entry = () => ({ schema: 1, id: 'test-family', admission: 'candidate', os: 'linux', architecture: 'arm64',
  image: 'sha256:' + 'a'.repeat(64), storageImage: 'sha256:' + 'b'.repeat(64), parentImage: 'sha256:' + 'c'.repeat(64),
  binarySha256: 'd'.repeat(64), supervisorSha256: 'e'.repeat(64),
  sourceFiles: { 'packages/platform/package.json': 'f'.repeat(64), 'packages/runtime/package.json': '1'.repeat(64) } });

test('catalog data accepts only immutable local family and source declarations', () => {
  assert.deepEqual(validateRuntimeFamily(entry()), entry());
  assert.throws(() => runtimeFamily('unknown-family'), /Unknown shipped/);
  assert.throws(() => selectFamily([entry()], 'test-family'), /candidate/);
  assert.equal(selectFamily([entry()], 'test-family', 'candidate').admission, 'candidate');
  assert.equal(selectFamily([entry()], 'test-family', 'enrolled').admission, 'candidate');
  assert.throws(() => selectFamily([entry()], 'test-family', 'unrestricted'));
  for (const mutate of [
    e => { e.image = 'runtime:tag'; }, e => { e.admission = 'enabled'; }, e => { e.architecture = 'amd64'; },
    e => { e.sourceFiles['packages/runtime/src/../private.mjs'] = 'a'.repeat(64); },
    e => { e.sourceFiles['/etc/passwd'] = 'a'.repeat(64); }, e => { e.sourceFiles = {}; },
  ]) { const value = entry(); mutate(value); assert.throws(() => validateRuntimeFamily(value)); }
});

test('source inventory rejects linked programs and private qualification files in production', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fogd-runtime-sources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['platform', 'runtime']) {
    await mkdir(join(root, 'packages', name, 'src'), { recursive: true });
    await mkdir(join(root, 'packages', name, 'node_modules'));
    await writeFile(join(root, 'packages', name, 'package.json'), '{}');
    await writeFile(join(root, 'packages', name, 'src/main.mjs'), 'export const value=1;');
  }
  const files = await programInventory(root, true); assert.equal(Object.keys(files).length, 4);
  await writeFile(join(root, 'packages/runtime/src/stale.mjs'), 'export const stale=1;');
  assert.ok(Object.hasOwn(await programInventory(root), 'packages/runtime/src/stale.mjs'));
  await symlink(join(root, 'packages/runtime/src/main.mjs'), join(root, 'packages/runtime/src/link.mjs'));
  await assert.rejects(programInventory(root), /regular file/);
  await rm(join(root, 'packages/runtime/src/link.mjs'));
  await mkdir(join(root, 'qualification')); await assert.rejects(programInventory(root, true), /Private qualification/);
  await rm(join(root, 'qualification'), { recursive: true });
  await writeFile(join(root, 'packages/runtime/private.json'), '{}');
  await assert.rejects(programInventory(root, true), /Unexpected runtime package entries/);
});

function inspector(expected, inventory, calls) {
  return async args => {
    calls.push(args);
    if (args[0] === 'info') return JSON.stringify({ OSType: 'linux', Architecture: 'aarch64' });
    if (args[0] === 'image') {
      const id = args.at(-1);
      return JSON.stringify([{ Id: id, Os: 'linux', Architecture: 'arm64', Config: { WorkingDir: '/app', Env: ['PATH=/usr/local/bin:/usr/bin:/bin'] } }]);
    }
    if (args.at(-1).includes('Runtime program must not be a symlink')) return JSON.stringify({ binarySha256: expected.binarySha256, supervisorSha256: expected.supervisorSha256 });
    return JSON.stringify(inventory);
  };
}
test('catalog preboot checks the complete source set without mounting or starting application state', async () => {
  const expected = entry(), calls = [];
  await verifyRuntimeFamily(expected, inspector(expected, expected.sourceFiles, calls));
  assert.equal(calls.filter(args => args[0] === 'run').length, 2);
  assert.ok(calls.every(args => !args.includes('--mount') && !args.includes('compose')));
  for (const inventory of [{}, { ...expected.sourceFiles, 'packages/runtime/src/stale.mjs': '0'.repeat(64) },
    { ...expected.sourceFiles, 'packages/runtime/package.json': '0'.repeat(64) }]) {
    await assert.rejects(verifyRuntimeFamily(expected, inspector(expected, inventory, [])), /source verification failed/);
  }
});
