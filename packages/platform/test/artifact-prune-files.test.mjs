import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir, lstat, readlink, symlink, link, unlink, rmdir } from 'node:fs/promises';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { inspectRetainedArtifact } from '../src/artifact-inventory.mjs';
import { validatePruneTargets } from '../src/artifact-prune-manifest.mjs';
import { removeApprovedArtifacts } from '../src/artifact-prune-files.mjs';

const REFUSED = { code: 'ARTIFACT_PRUNE_REFUSED', message: 'Cannot prune retained artifacts; artifact contents no longer match the approved removal' };
const INVALID = { code: 'ARTIFACT_PRUNE_TARGETS_INVALID', message: 'Artifact prune targets are malformed; plan artifact retention again' };
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binary = Buffer.from([0, 255, 1, 254, 10, 13, 0]);
const FILES = { 'worker/index.js': 'export default {fetch(){}}', 'bin.wasm': binary, 'fogd-release.json': '{"app":"hello"}', 'public/assets/app.css': 'body{}' };
const EMPTY_DIRS = ['public/empty'];
const moduleUrl = pathToFileURL(join(import.meta.dirname, '../src/artifact-prune-files.mjs')).href;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'fogd-prune-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'artifacts');
  await mkdir(root);
  const artifact = async (name, files = FILES, dirs = EMPTY_DIRS) => {
    for (const [path, data] of Object.entries(files)) { await mkdir(join(root, name, path, '..'), { recursive: true }); await writeFile(join(root, name, path), data); }
    for (const dir of dirs) await mkdir(join(root, name, dir), { recursive: true });
    const { kind, ...target } = await inspectRetainedArtifact(root, name);
    return target;
  };
  return { root, artifact };
}

// Every entry under dir with its type and content, so "unchanged" covers links and special files.
async function snapshot(dir, prefix = '') {
  const rows = [];
  for (const name of (await readdir(join(dir, prefix))).sort()) {
    const path = join(prefix, name), info = await lstat(join(dir, path));
    if (info.isDirectory()) rows.push([path, 'dir'], ...await snapshot(dir, path));
    else if (info.isSymbolicLink()) rows.push([path, 'link', await readlink(join(dir, path))]);
    else if (info.isFile()) rows.push([path, 'file', info.ino, createHash('sha256').update(await readFile(join(dir, path))).digest('hex')]);
    else rows.push([path, 'special']);
  }
  return rows;
}

test('removes approved directory artifacts, including empty directories, and leaves unrelated data intact', async t => {
  const { root, artifact } = await fixture(t);
  const targets = [await artifact(id(1)), await artifact(id(2), { 'only.bin': binary }, [])];
  await artifact(id(3));
  await writeFile(join(root, 'unrelated.txt'), 'keep');
  const kept = await snapshot(root).then(rows => rows.filter(([path]) => !path.startsWith(id(1)) && !path.startsWith(id(2))));
  assert.equal(validatePruneTargets(targets), targets);
  await removeApprovedArtifacts(root, targets);
  assert.deepEqual(await snapshot(root), kept);
});

test('partial removal, an entirely missing target and repeated calls resume to full absence', async t => {
  const { root, artifact } = await fixture(t);
  const targets = [await artifact(id(1)), await artifact(id(2)), await artifact(id(4))];
  await artifact(id(3));
  const kept = (await snapshot(root)).filter(([path]) => path.startsWith(id(3)));
  await unlink(join(root, id(1), 'bin.wasm'));
  await unlink(join(root, id(1), 'public/assets/app.css'));
  await rmdir(join(root, id(1), 'public/assets'));
  await rm(join(root, id(2)), { recursive: true });
  await removeApprovedArtifacts(root, targets);
  assert.deepEqual(await snapshot(root), kept);
  await removeApprovedArtifacts(root, targets);
  assert.deepEqual(await snapshot(root), kept);
});

const mutations = {
  'changed byte with the same size': dir => writeFile(join(dir, 'bin.wasm'), Buffer.from([1, 255, 1, 254, 10, 13, 0])),
  'new file': dir => writeFile(join(dir, 'worker/extra.js'), 'x'),
  'new empty directory': dir => mkdir(join(dir, 'worker/unknown')),
  'file replaced by symlink': async dir => { await unlink(join(dir, 'bin.wasm')); await symlink('/etc/hosts', join(dir, 'bin.wasm')); },
  'directory replaced by symlink': async dir => { await rm(join(dir, 'public'), { recursive: true }); await symlink(tmpdir(), join(dir, 'public')); },
  'hardlinked file': dir => link(join(dir, 'bin.wasm'), join(dir, '..', 'outside-hardlink')),
  'FIFO': dir => { execFileSync('mkfifo', [join(dir, 'worker/pipe')]); },
  'release directory replaced by symlink': async dir => { await rm(dir, { recursive: true }); await symlink(tmpdir(), dir); },
};

for (const [name, mutate] of Object.entries(mutations)) {
  test(`refuses ${name} before deleting anything across targets`, async t => {
    const { root, artifact } = await fixture(t);
    const targets = [await artifact(id(1)), await artifact(id(2))];
    await writeFile(join(root, 'unrelated.txt'), 'keep');
    await mutate(join(root, id(2)));
    const before = await snapshot(root);
    await assert.rejects(removeApprovedArtifacts(root, targets), REFUSED);
    assert.deepEqual(await snapshot(root), before);
  });
}

test('refuses a symlinked artifacts root', async t => {
  const { root, artifact } = await fixture(t);
  const targets = [await artifact(id(1))];
  const alias = join(root, '..', 'alias');
  await symlink(root, alias);
  const before = await snapshot(root);
  await assert.rejects(removeApprovedArtifacts(alias, targets), REFUSED);
  assert.deepEqual(await snapshot(root), before);
});

test('malformed, traversal, absolute and alias manifests are refused before the filesystem is touched', async t => {
  const { root, artifact } = await fixture(t);
  const good = await artifact(id(1));
  const before = await snapshot(root);
  const file = path => ({ path, bytes: 1, sha256: '0'.repeat(64) });
  const withFiles = (files, directories = []) => ({ ...good, files, directories, bytes: files.length });
  const bad = [
    [], 'x', null, [{ ...good, kind: 'directory' }], [{ ...good, id: 'ABCDEF00-0000-4000-8000-000000000001' }], [good, good],
    [{ ...good, digest: 'A'.repeat(64) }], [{ ...good, bytes: good.bytes + 1 }], [{ ...good, bytes: -1 }],
    [{ ...good, id: [good.id] }], [{ ...good, digest: [good.digest] }],
    [withFiles([{ ...file('a'), sha256: ['0'.repeat(64)] }])],
    ...['.', '../x', '/etc/passwd', './x', 'a//b', 'a/', 'a\\b', 'a\u0000b', 'a\nb', 'x'.repeat(513), 'y'.repeat(256)].map(path => [withFiles([file(path)])]),
    [withFiles([file('a/x')])], [withFiles([file('a/b/x')], ['a/b'])], [withFiles([file('a')], ['a'])],
    [withFiles([file('b'), file('a')])], [withFiles([file('a'), file('a')])], [withFiles([], ['b', 'a'])], [withFiles([], ['../a'])],
    [withFiles([{ ...file('a'), extra: 1 }])], [withFiles([{ ...file('a'), sha256: 'z'.repeat(64) }])],
  ];
  for (const targets of bad) {
    assert.throws(() => validatePruneTargets(targets), INVALID, JSON.stringify(targets)?.slice(0, 80));
    await assert.rejects(removeApprovedArtifacts(root, targets), INVALID);
  }
  assert.deepEqual(await snapshot(root), before);
});

// Wraps one Node fs side effect in a child so the real operation lands and the process dies right after it.
function interruptedChild(root, targets, operation, count) {
  const script = `
    import fsp from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const [operation, count, root, targets, url] = process.argv.slice(1);
    const original = fsp[operation];
    let calls = 0;
    fsp[operation] = async (...args) => { await original(...args); if (++calls === Number(count)) process.kill(process.pid, 'SIGKILL'); };
    syncBuiltinESMExports();
    const { removeApprovedArtifacts } = await import(url);
    await removeApprovedArtifacts(root, JSON.parse(targets));`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script, operation, String(count), root, JSON.stringify(targets), moduleUrl]);
}

for (const [operation, count] of [['unlink', 1], ['unlink', 6], ['rmdir', 3]]) {
  test(`a process killed after ${operation} #${count} keeps unremoved data and resumes`, async t => {
    const { root, artifact } = await fixture(t);
    const targets = [await artifact(id(1)), await artifact(id(2))];
    await artifact(id(3));
    const kept = (await snapshot(root)).filter(([path]) => path.startsWith(id(3)));
    const child = interruptedChild(root, targets, operation, count);
    assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
    const interrupted = await snapshot(root);
    assert.ok(interrupted.length > kept.length && interrupted.some(([path]) => path === id(2)));
    assert.deepEqual(interrupted.filter(([path]) => path.startsWith(id(3))), kept);
    await removeApprovedArtifacts(root, targets);
    assert.deepEqual(await snapshot(root), kept);
  });
}
