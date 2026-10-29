import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { transferFixture } from './fixtures/transfer-cli.mjs';

const exec = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function releaseFixture(t) {
  const f = await transferFixture(t), directory = join(f.root, 'fogd-0.1.0-linux-arm64');
  const invoke = (args, env = {}) => exec(process.execPath, [f.cli, 'release', ...args], { env: { ...f.env, ...env }, timeout: 30000 });
  const exported = JSON.parse((await invoke(['export', directory, '--version', '0.1.0', '--runtime', f.entry.id])).stdout);
  return { ...f, directory, invoke, exported };
}
test('a versioned release independently verifies both bundles without Docker or bundled imports', async t => {
  const f = await releaseFixture(t), expected = f.exported.manifestSha256;
  const standalone = JSON.parse((await exec(process.execPath, [join(f.directory, 'verify-release.mjs'), f.directory, expected], { env: { PATH: '' } })).stdout);
  assert.equal(standalone.version, '0.1.0'); assert.equal(standalone.runtime, f.entry.id); assert.equal(standalone.dockerContacted, false);
  assert.equal(f.exported.bootstrapSha256, hash(await readFile(join(f.directory, 'verify-release.mjs'))));
  const ordinary = JSON.parse((await f.invoke(['verify', f.directory, '--expected-manifest', expected], { PATH: '' })).stdout);
  assert.equal(ordinary.runtimeManifestSha256, f.exported.runtimeManifestSha256);
  assert.equal(ordinary.clientManifestSha256, f.exported.clientManifestSha256); assert.equal(ordinary.dockerContacted, false);
  const client = JSON.parse((await exec(process.execPath, [join(f.directory, 'client/verify-client.mjs'), join(f.directory, 'client'), standalone.clientManifestSha256], { env: { PATH: '' } })).stdout);
  assert.equal(client.dockerContacted, false);
});
test('release operator imports through the existing immutable runtime path without starting services', async t => {
  const f = await releaseFixture(t), output = join(f.root, 'operator');
  const imported = JSON.parse((await exec(process.execPath, [join(f.directory, 'operator/program/packages/cli/bin/fogd.js'), 'runtime', 'import', join(f.directory, 'operator'),
    '--runtime', f.entry.id, '--expected-manifest', f.exported.runtimeManifestSha256, '--output', output], { env: f.env, timeout: 30000 })).stdout);
  assert.equal(imported.servicesStarted, false); assert.equal(imported.family, f.entry.id);
  const calls = (await readFile(f.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(args => args[0] === 'image' && args[1] === 'load'));
  assert.ok(calls.every(args => ['info', 'image', 'run'].includes(args[0])));
});
for (const version of ['../private', '01.2.3', '1.2']) test(`invalid release version refuses before destination or Docker: ${version}`, async t => {
  const f = await transferFixture(t), output = join(f.root, 'release');
  await assert.rejects(exec(process.execPath, [f.cli, 'release', 'export', output, '--runtime', f.entry.id, '--version', version], { env: f.env }), error => error.code === 1 && /Release version/.test(error.stderr));
  await assert.rejects(access(output), { code: 'ENOENT' }); await assert.rejects(access(f.log), { code: 'ENOENT' });
});
test('changed release version refuses the independently retained manifest digest', async t => {
  const f = await releaseFixture(t), path = join(f.directory, 'manifest.json'), manifest = JSON.parse(await readFile(path));
  manifest.version = '0.2.0'; await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
  await assert.rejects(f.invoke(['verify', f.directory, '--expected-manifest', f.exported.manifestSha256], { PATH: '' }), error => error.code === 1 && /manifest checksum differs/.test(error.stderr));
});
test('a release cannot relabel the qualified family of its nested operator bundle', async t => {
  const f = await releaseFixture(t), path = join(f.directory, 'manifest.json'), manifest = JSON.parse(await readFile(path));
  manifest.runtime = 'another-family'; const bytes = JSON.stringify(manifest, null, 2) + '\n'; await writeFile(path, bytes);
  await assert.rejects(f.invoke(['verify', f.directory, '--expected-manifest', hash(bytes)], { PATH: '' }), error => error.code === 1 && /Release runtime differs/.test(error.stderr));
});
test('release verification refuses client corruption before any bundled CLI can run', async t => {
  const f = await releaseFixture(t); await writeFile(join(f.directory, 'client/fogd.mjs'), 'throw Error("changed client");\n');
  await assert.rejects(f.invoke(['verify', f.directory, '--expected-manifest', f.exported.manifestSha256], { PATH: '' }), error => error.code === 1 && /member checksum differs/.test(error.stderr));
});
test('linked release inputs refuse rather than following a private host path', async t => {
  const f = await releaseFixture(t); await symlink(f.source, join(f.directory, 'private'));
  await assert.rejects(f.invoke(['verify', f.directory, '--expected-manifest', f.exported.manifestSha256], { PATH: '' }), error => error.code === 1 && /without symlinks/.test(error.stderr));
});
