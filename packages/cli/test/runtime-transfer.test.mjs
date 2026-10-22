import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, symlink, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { transferFixture } from './fixtures/transfer-cli.mjs';
const exec = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const selection = (f, sha) => ['--runtime', f.entry.id, '--expected-manifest', sha];

test('export is self-contained and import loads pinned images without starting resources', async t => {
  const f = await transferFixture(t), exported = await f.exportBundle();
  assert.equal(exported.bootstrapSha256, digest(await readFile(join(f.bundle, 'verify-transfer.mjs'))));
  const bootstrap = await exec(process.execPath, [join(f.bundle, 'verify-transfer.mjs'), f.bundle, exported.manifestSha256], { cwd: f.root, env: { PATH: process.env.PATH, HOME: f.root } });
  assert.equal(JSON.parse(bootstrap.stdout).dockerContacted, false);
  const verified = JSON.parse((await f.invoke(['verify', f.bundle, ...selection(f, exported.manifestSha256)])).stdout);
  assert.equal(verified.dockerContacted, false); assert.equal(verified.family, f.entry.id);
  await writeFile(f.log, '');
  const output = join(f.root, 'installed');
  const imported = JSON.parse((await f.invoke(['import', f.bundle, ...selection(f, exported.manifestSha256), '--output', output])).stdout);
  assert.equal(imported.servicesStarted, false);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.filter(args => args[0] === 'image' && args[1] === 'load'), [['image', 'load']]);
  assert.ok(calls.every(args => ['info', 'image', 'run'].includes(args[0])));
  const help = await exec(process.execPath, [join(output, 'packages/cli/bin/fogd.js'), '--help'], { cwd: output, env: { PATH: process.env.PATH, HOME: f.root } });
  assert.match(help.stdout, /fogd up/);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'transfer-receipt.json'))).images, [f.entry.image, f.entry.storageImage]);
  await assert.rejects(access(join(output, '.env')), { code: 'ENOENT' });
  await assert.rejects(access(join(output, '.fogd')), { code: 'ENOENT' });
});

for (const [name, change, message] of [
  ['altered file', f => writeFile(join(f.bundle, 'program/compose.yaml'), 'changed'), /checksum differs/],
  ['missing file', f => rm(join(f.bundle, 'program/compose.yaml')), /missing or unexpected/],
  ['extra private file', f => writeFile(join(f.bundle, '.env'), 'private'), /missing or unexpected/],
  ['empty extra directory', f => mkdir(join(f.bundle, 'extra')), /Empty directories/],
  ['symlink member', async f => { await rm(join(f.bundle, 'program/compose.yaml')); await symlink(join(f.source, 'compose.yaml'), join(f.bundle, 'program/compose.yaml')); }, /without symlinks/],
]) test(`import refuses ${name} before contacting Docker`, async t => {
  const f = await transferFixture(t), exported = await f.exportBundle();
  await writeFile(f.log, ''); await change(f);
  const output = join(f.root, 'installed');
  await assert.rejects(f.invoke(['import', f.bundle, ...selection(f, exported.manifestSha256), '--output', output]), error => error.code === 1 && message.test(error.stderr));
  assert.equal(await readFile(f.log, 'utf8'), '');
  await assert.rejects(access(output), { code: 'ENOENT' });
});

test('wrong manifest digest refuses before Docker or output creation', async t => {
  const f = await transferFixture(t); await f.exportBundle(); await writeFile(f.log, '');
  await assert.rejects(f.invoke(['import', f.bundle, ...selection(f, '0'.repeat(64)), '--output', join(f.root, 'installed')]), error => error.code === 1 && /manifest checksum differs/.test(error.stderr));
  assert.equal(await readFile(f.log, 'utf8'), '');
});

test('unsupported target architecture refuses before image load or output creation', async t => {
  const f = await transferFixture(t), exported = await f.exportBundle(); await writeFile(f.log, '');
  const output = join(f.root, 'installed');
  await assert.rejects(f.invoke(['import', f.bundle, ...selection(f, exported.manifestSha256), '--output', output], { FOGD_TEST_ARCH: 'amd64' }), error => error.code === 1 && /Linux arm64/.test(error.stderr));
  assert.deepEqual((await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse), [['info', '--format', '{{json .}}']]);
  await assert.rejects(access(output), { code: 'ENOENT' });
});

test('existing import destination is retained before any Docker query', async t => {
  const f = await transferFixture(t), exported = await f.exportBundle(); await writeFile(f.log, '');
  const output = join(f.root, 'installed'); await mkdir(output); await writeFile(join(output, 'keep'), 'operator data');
  await assert.rejects(f.invoke(['import', f.bundle, ...selection(f, exported.manifestSha256), '--output', output]), error => error.code === 1 && /already exists/.test(error.stderr));
  assert.equal(await readFile(join(output, 'keep'), 'utf8'), 'operator data');
  assert.equal(await readFile(f.log, 'utf8'), '');
});

test('an independently hashed but disallowed manifest still refuses before Docker', async t => {
  const f = await transferFixture(t); await f.exportBundle(); await writeFile(f.log, '');
  const path = join(f.bundle, 'manifest.json'), manifest = JSON.parse(await readFile(path));
  manifest.files['program/.env'] = { bytes: 0, sha256: digest('') };
  await writeFile(join(f.bundle, 'program/.env'), '');
  const text = JSON.stringify(manifest, null, 2) + '\n'; await writeFile(path, text);
  await assert.rejects(f.invoke(['verify', f.bundle, ...selection(f, digest(text))]), error => error.code === 1 && /Invalid transfer member/.test(error.stderr));
  assert.equal(await readFile(f.log, 'utf8'), '');
});

test('containerd image-store target refuses before loading or publishing an installation', async t => {
  const f = await transferFixture(t), exported = await f.exportBundle(); await writeFile(f.log, '');
  const output = join(f.root, 'installed');
  await assert.rejects(f.invoke(['import', f.bundle, ...selection(f, exported.manifestSha256), '--output', output], { FOGD_TEST_STORE: 'overlayfs' }), error => error.code === 1 && /classic overlay2/.test(error.stderr));
  assert.deepEqual((await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse), [['info', '--format', '{{json .}}']]);
  await assert.rejects(access(output), { code: 'ENOENT' });
});

test('standalone verifier refuses corruption rather than only returning a successful process exit', async t => {
  const f = await transferFixture(t), exported = await f.exportBundle();
  await writeFile(join(f.bundle, 'program/compose.yaml'), 'changed');
  await assert.rejects(exec(process.execPath, [join(f.bundle, 'verify-transfer.mjs'), f.bundle, exported.manifestSha256], { env: { PATH: process.env.PATH, HOME: f.root } }), error => error.code === 1 && /member checksum differs/.test(error.stderr));
});

test('import uses its private verified snapshot when the original transfer changes during image load', async t => {
  const f = await transferFixture(t), exported = await f.exportBundle(), member = join(f.bundle, 'program/compose.yaml');
  const original = await readFile(member, 'utf8'), output = join(f.root, 'installed');
  await f.invoke(['import', f.bundle, ...selection(f, exported.manifestSha256), '--output', output], { FOGD_TEST_MUTATE_MEMBER: member });
  assert.equal(await readFile(join(output, 'compose.yaml'), 'utf8'), original);
  assert.equal(await readFile(member, 'utf8'), original + 'changed during load');
});

for (const [family, message] of [['unknown-family', /Unknown shipped/], ['', /Usage:/]]) test(`unknown or empty family refuses before Docker: ${family}`, async t => {
  const f = await transferFixture(t);
  await assert.rejects(f.invoke(['export', f.bundle, `--runtime=${family}`]), error => error.code === 1 && message.test(error.stderr));
  await assert.rejects(access(f.log), { code: 'ENOENT' });
  await assert.rejects(access(f.bundle), { code: 'ENOENT' });
});

test('a candidate catalog refuses ordinary software export before Docker', async t => {
  const f = await transferFixture(t);
  await writeFile(f.catalog, JSON.stringify([{ ...f.entry, admission: 'candidate' }]));
  await assert.rejects(f.invoke(['export', f.bundle, '--runtime', f.entry.id]), error => error.code === 1 && /candidate; ordinary enrollment remains closed/.test(error.stderr));
  await assert.rejects(access(f.log), { code: 'ENOENT' });
  await assert.rejects(access(f.bundle), { code: 'ENOENT' });
});

test('a frozen runtime source mismatch refuses export before Docker or destination creation', async t => {
  const f = await transferFixture(t);
  await writeFile(join(f.source, 'packages/runtime/src/files.mjs'), 'changed');
  await assert.rejects(f.invoke(['export', f.bundle, '--runtime', f.entry.id]), error => error.code === 1 && /drifted from the frozen family/.test(error.stderr));
  await assert.rejects(access(f.log), { code: 'ENOENT' });
  await assert.rejects(access(f.bundle), { code: 'ENOENT' });
});

test('a FIFO in a transfer is refused without trying to read it', async t => {
  const f = await transferFixture(t), exported = await f.exportBundle(); await writeFile(f.log, '');
  await exec('mkfifo', [join(f.bundle, 'fifo')]);
  await assert.rejects(f.invoke(['verify', f.bundle, ...selection(f, exported.manifestSha256)]), error => error.code === 1 && /regular files and directories/.test(error.stderr));
  assert.equal(await readFile(f.log, 'utf8'), '');
});

test('export cannot hide its output inside public source through a directory symlink', async t => {
  const f = await transferFixture(t), alias = join(f.root, 'source-alias');
  await symlink(join(f.source, 'packages/cli/src'), alias, 'dir');
  await assert.rejects(f.invoke(['export', join(alias, 'bundle'), '--runtime', f.entry.id]), error => error.code === 1 && /outside public source/.test(error.stderr));
  await assert.rejects(access(f.log), { code: 'ENOENT' });
  await assert.rejects(access(join(alias, 'bundle')), { code: 'ENOENT' });
});

test('import cannot write inside the transfer through a directory symlink', async t => {
  const f = await transferFixture(t), exported = await f.exportBundle(), alias = join(f.root, 'bundle-alias');
  await writeFile(f.log, ''); await symlink(f.bundle, alias, 'dir');
  await assert.rejects(f.invoke(['import', f.bundle, ...selection(f, exported.manifestSha256), '--output', join(alias, 'installed')]), error => error.code === 1 && /outside the transfer/.test(error.stderr));
  assert.equal(await readFile(f.log, 'utf8'), '');
  await assert.rejects(access(join(f.bundle, 'installed')), { code: 'ENOENT' });
});

test('multiple stream chunks reach the installed program without truncation', async t => {
  const f = await transferFixture(t), body = '// public operator source\n'.repeat(8192);
  await writeFile(join(f.source, 'packages/cli/src/large.mjs'), body);
  const exported = await f.exportBundle(), output = join(f.root, 'installed');
  await f.invoke(['import', f.bundle, ...selection(f, exported.manifestSha256), '--output', output]);
  assert.equal(await readFile(join(output, 'packages/cli/src/large.mjs'), 'utf8'), body);
});

for (const [name, member, change, message] of [
  ['a different bundled catalog', 'program/packages/cli/src/runtime/catalog.json', text => { const value = JSON.parse(text); value[0].admission = 'candidate'; return JSON.stringify(value); }, /catalog differs/],
  ['a bootstrap different from its source', 'verify-transfer.mjs', text => text + '\n// changed bootstrap\n', /bootstrap differs/],
]) test(`a rehashed transfer still refuses ${name}`, async t => {
  const f = await transferFixture(t); await f.exportBundle(); await writeFile(f.log, '');
  const bytes = change(await readFile(join(f.bundle, member), 'utf8')); await writeFile(join(f.bundle, member), bytes);
  const manifest = JSON.parse(await readFile(join(f.bundle, 'manifest.json')));
  manifest.files[member] = { bytes: Buffer.byteLength(bytes), sha256: digest(bytes) };
  const text = JSON.stringify(manifest, null, 2) + '\n'; await writeFile(join(f.bundle, 'manifest.json'), text);
  await assert.rejects(f.invoke(['verify', f.bundle, ...selection(f, digest(text))]), error => error.code === 1 && message.test(error.stderr));
  assert.equal(await readFile(f.log, 'utf8'), '');
});

test('export refuses an existing bundle without changing it or querying Docker', async t => {
  const f = await transferFixture(t), exported = await f.exportBundle(); await writeFile(f.log, '');
  await assert.rejects(f.exportBundle(), error => error.code === 1 && /already exists/.test(error.stderr));
  assert.equal(digest(await readFile(join(f.bundle, 'manifest.json'))), exported.manifestSha256);
  assert.equal(await readFile(f.log, 'utf8'), '');
});

test('extra platform source refuses export before image inspection or saving', async t => {
  const f = await transferFixture(t);
  await writeFile(join(f.source, 'packages/platform/src/extra.mjs'), '// not in the qualified source set');
  await assert.rejects(f.exportBundle(), error => error.code === 1 && /drifted from the frozen family/.test(error.stderr));
  await assert.rejects(access(f.log), { code: 'ENOENT' });
  await assert.rejects(access(f.bundle), { code: 'ENOENT' });
});
