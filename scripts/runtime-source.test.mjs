import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRuntimeSource } from './runtime-source.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, env }).toString().trim();
const lock = 'version = 4\n';
const addLine = (path, before, line) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${before.length} +1,${before.length + 1} @@\n${before.map(text => ` ${text}\n`).join('')}+${line}\n`;
const patches = { 'one.patch': addLine('src/main.rs', ['fn main() {}'], '// one'), 'two.patch': addLine('src/main.rs', ['fn main() {}', '// one'], '// two') };

async function fixture({ patchFiles = patches, order = Object.keys(patchFiles) } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'runtime-source-'));
  const repository = join(base, 'celld'), patchRoot = join(base, 'fogd');
  await mkdir(join(repository, 'src'), { recursive: true }); await mkdir(patchRoot);
  await writeFile(join(repository, 'Cargo.lock'), lock);
  await writeFile(join(repository, 'src/main.rs'), 'fn main() {}\n');
  await writeFile(join(repository, 'build.sh'), '#!/bin/sh\n', { mode: 0o755 });
  git(repository, 'init', '-q'); git(repository, 'add', '.'); git(repository, 'commit', '-qm', 'pinned');
  for (const [name, text] of Object.entries(patchFiles)) await writeFile(join(patchRoot, name), text);
  const manifest = { schema: 1, repository: 'https://example.invalid/celld.git', revision: git(repository, 'rev-parse', 'HEAD'), cargoLockSha256: sha256(lock),
    patches: order.map(path => ({ path, sha256: sha256(patchFiles[path]) })), sourceInventorySha256: expectedInventory() };
  return { base, repository, patchRoot, manifest, output: join(base, 'out') };
}

function expectedInventory() {
  const files = { 'Cargo.lock': [lock, '644'], 'build.sh': ['#!/bin/sh\n', '755'], 'src/main.rs': ['fn main() {}\n// one\n// two\n', '644'] };
  return sha256(Object.entries(files).map(([path, [text, mode]]) => `${sha256(text)} ${mode}  ${path}\n`).join(''));
}

const failure = async output => JSON.parse(await readFile(join(output, 'failure.json'), 'utf8'));

test('exports pinned objects and applies ordered patches, ignoring the dirty checkout', async () => {
  const f = await fixture();
  await writeFile(join(f.repository, 'src/main.rs'), 'dirty\n'); await writeFile(join(f.repository, 'untracked.rs'), 'x');
  await writeFile(join(f.repository, 'Cargo.lock'), 'staged\n'); git(f.repository, 'add', 'Cargo.lock');
  const receipt = await prepareRuntimeSource(f);
  assert.equal(await readFile(join(f.output, 'source/src/main.rs'), 'utf8'), 'fn main() {}\n// one\n// two\n');
  assert.deepEqual(await readdir(join(f.output, 'source')), ['Cargo.lock', 'build.sh', 'src']);
  assert.deepEqual({ ...receipt, patches: receipt.patches.map(patch => patch.path) }, { schema: 1, complete: true, repository: f.manifest.repository, revision: f.manifest.revision,
    cargoLockSha256: sha256(lock), patches: ['one.patch', 'two.patch'], sourceFiles: 3, sourceInventorySha256: expectedInventory(), compiled: false, qualified: false });
  assert.deepEqual(JSON.parse(await readFile(join(f.output, 'receipt.json'), 'utf8')), receipt);
});

test('local filters, hooks and fsmonitor configuration never run', async () => {
  const f = await fixture();
  const marker = join(f.base, 'ran');
  await writeFile(join(f.repository, '.gitattributes'), '* filter=evil\n'); git(f.repository, 'add', '.gitattributes'); git(f.repository, 'commit', '-qm', 'attributes');
  for (const key of ['filter.evil.smudge', 'filter.evil.clean', 'core.fsmonitor']) git(f.repository, 'config', key, `touch ${marker}; cat`);
  git(f.repository, 'config', 'core.hooksPath', join(f.base, 'hooks'));
  const manifest = { ...f.manifest, revision: git(f.repository, 'rev-parse', 'HEAD'), sourceInventorySha256: '0'.repeat(64) };
  await assert.rejects(prepareRuntimeSource({ ...f, manifest }), /source inventory/);
  assert.equal(await readFile(join(f.output, 'source/.gitattributes'), 'utf8'), '* filter=evil\n');
  assert.equal(existsSync(marker), false);
});

test('replacement refs cannot substitute another commit for the pinned revision', async () => {
  const f = await fixture();
  await writeFile(join(f.repository, 'src/main.rs'), 'replacement\n');
  git(f.repository, 'add', '.'); git(f.repository, 'commit', '-qm', 'replacement');
  git(f.repository, 'replace', f.manifest.revision, git(f.repository, 'rev-parse', 'HEAD'));
  assert.equal(git(f.repository, 'show', `${f.manifest.revision}:src/main.rs`), 'replacement');
  const receipt = await prepareRuntimeSource(f);
  assert.equal(await readFile(join(f.output, 'source/src/main.rs'), 'utf8'), 'fn main() {}\n// one\n// two\n');
  assert.equal(receipt.sourceInventorySha256, expectedInventory());
});

test('missing promisor objects refuse locally without executing a remote helper', async () => {
  const f = await fixture();
  const marker = join(f.base, 'remote-called'), helper = join(f.base, 'remote.sh');
  await writeFile(helper, `#!/bin/sh\ntouch '${marker.replaceAll("'", "'\\''")}'\nexit 1\n`);
  git(f.repository, 'config', 'remote.origin.url', `ext::sh ${helper.replaceAll('%', '%%').replaceAll(' ', '% ')}`);
  git(f.repository, 'config', 'remote.origin.promisor', 'true');
  git(f.repository, 'config', 'protocol.ext.allow', 'always');
  const blob = git(f.repository, 'rev-parse', 'HEAD:src/main.rs');
  await rm(join(f.repository, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  await assert.rejects(prepareRuntimeSource(f), /missing or has the wrong type/);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(f.output), false);
  assert.throws(() => git(f.repository, 'cat-file', '-p', blob));
  assert.equal(existsSync(marker), true, 'the control confirms the repository would attempt a remote helper');
});

test('Git export attributes cannot omit files from the prepared tree', async () => {
  const f = await fixture();
  await writeFile(join(f.repository, '.gitattributes'), 'Cargo.lock export-ignore\n');
  git(f.repository, 'add', '.'); git(f.repository, 'commit', '-qm', 'export attributes');
  const manifest = { ...f.manifest, revision: git(f.repository, 'rev-parse', 'HEAD'), sourceInventorySha256: '0'.repeat(64) };
  await assert.rejects(prepareRuntimeSource({ ...f, manifest }), /source inventory/);
  assert.equal(await readFile(join(f.output, 'source/Cargo.lock'), 'utf8'), lock);
  assert.equal(await readFile(join(f.output, 'source/.gitattributes'), 'utf8'), 'Cargo.lock export-ignore\n');
  assert.equal(existsSync(join(f.output, 'receipt.json')), false);
});

test('the public CLI refuses synthetic source instead of accepting its own manifest', async () => {
  const f = await fixture();
  assert.throws(() => execFileSync(process.execPath, ['scripts/runtime-source.mjs', f.repository, f.output], { env, stdio: 'pipe' }), /missing or has the wrong type/);
  assert.equal(existsSync(f.output), false);
});

test('mismatched revision, patch and lock hashes fail before any output exists', async () => {
  const f = await fixture();
  const cases = [[{ revision: 'f'.repeat(40) }, /missing or has the wrong type/], [{ revision: git(f.repository, 'rev-parse', 'HEAD^{tree}') }, /wrong type/],
    [{ revision: 'HEAD' }, /full revision/], [{ cargoLockSha256: '0'.repeat(64) }, /Pinned Cargo.lock/],
    [{ patches: [{ ...f.manifest.patches[0], sha256: '0'.repeat(64) }] }, /one.patch does not match/]];
  for (const [change, error] of cases) await assert.rejects(prepareRuntimeSource({ ...f, manifest: { ...f.manifest, ...change } }), error);
  assert.equal(existsSync(f.output), false);
});

test('an existing output is never reused or overwritten', async () => {
  const f = await fixture();
  await mkdir(f.output); await writeFile(join(f.output, 'keep'), 'mine');
  await assert.rejects(prepareRuntimeSource(f), /EEXIST/);
  assert.deepEqual(await readdir(f.output), ['keep']);
});

test('partial patch failure is retained without a receipt', async () => {
  const f = await fixture({ order: ['two.patch', 'one.patch'] });
  await assert.rejects(prepareRuntimeSource(f), /patch does not apply/);
  assert.deepEqual((await readdir(f.output)).sort(), ['failure.json', 'source']);
  assert.equal((await failure(f.output)).complete, false);
});

test('a patch that changes Cargo.lock or adds a symlink is rejected after assembly', async () => {
  const lockPatch = addLine('Cargo.lock', ['version = 4'], '# changed');
  const linkPatch = 'diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n';
  for (const [text, error] of [[lockPatch, /Patched Cargo.lock/], [linkPatch, /unsafe entry link/]]) {
    const f = await fixture({ patchFiles: { ...patches, 'bad.patch': text }, order: ['one.patch', 'two.patch', 'bad.patch'] });
    await assert.rejects(prepareRuntimeSource(f), error);
    assert.match((await failure(f.output)).error, error);
    assert.equal(existsSync(join(f.output, 'receipt.json')), false);
  }
});

test('pinned symlinks are refused before output creation', async () => {
  const f = await fixture();
  await symlink('/etc/passwd', join(f.repository, 'escape')); git(f.repository, 'add', 'escape'); git(f.repository, 'commit', '-qm', 'link');
  await assert.rejects(prepareRuntimeSource({ ...f, manifest: { ...f.manifest, revision: git(f.repository, 'rev-parse', 'HEAD') } }), /unsupported entry escape \(120000\)/);
  assert.equal(existsSync(f.output), false);
});

test('outputs inside inputs are refused, including through a symlinked parent', async () => {
  const f = await fixture();
  await symlink(join(f.repository, 'src'), join(f.base, 'alias'));
  await mkdir(join(f.base, '..out'));
  for (const output of [f.repository, join(f.repository, 'out'), join(f.repository, '.git/out'), join(f.patchRoot, 'out'), join(f.base, 'alias/out')]) {
    await assert.rejects(prepareRuntimeSource({ ...f, output }), /Output must be outside input/);
  }
  assert.equal(existsSync(join(f.repository, 'src/out')), false);
  await prepareRuntimeSource({ ...f, output: join(f.base, '..out/ok') });
});

test('the pinned celld chain prepares from local objects', { skip: !existsSync('.upstream/celld/.git') && 'no local celld objects' }, async () => {
  const manifest = JSON.parse(await readFile('docker/runtime-source.json', 'utf8'));
  const output = join(await mkdtemp(join(tmpdir(), 'runtime-source-pinned-')), 'out');
  const receipt = await prepareRuntimeSource({ repository: '.upstream/celld', output, manifest });
  assert.deepEqual(receipt.patches.map(patch => patch.path.replace(/^patches\/celld-0\.6\.2-|\.patch$/g, '')), ['preaccept-attachment', 'cron-retry', 'cron-controls', 'runtime-identity', 'runtime-binding']);
  assert.equal(receipt.sourceInventorySha256, manifest.sourceInventorySha256);
});
