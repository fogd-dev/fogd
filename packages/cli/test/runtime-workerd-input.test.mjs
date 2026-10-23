import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, link, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { prepareWorkerd } from '../../../docker/runtime-workerd.mjs';

const version = '1.20261016.1';
const platformPackage = '@cloudflare/workerd-linux-arm64';
function elf() { const bytes = Buffer.alloc(64); bytes.set([127, 69, 76, 70, 2, 1, 1]); bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(183, 18); return bytes; }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-workerd-input-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'workerd'), platform = join(directory, 'node_modules', platformPackage);
  await mkdir(join(directory, 'bin'), { recursive: true }); await mkdir(join(platform, 'bin'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'workerd', version, optionalDependencies: { [platformPackage]: version } }));
  await writeFile(join(platform, 'package.json'), JSON.stringify({ name: platformPackage, version, os: ['linux'], cpu: ['arm64'] }));
  const target = join(directory, 'bin/workerd'), binary = join(platform, 'bin/workerd');
  await writeFile(target, '#!/usr/bin/env node\nthrow Error("installer must not run")\n', { mode: 0o755 }); await writeFile(binary, elf(), { mode: 0o755 });
  return { root, directory, platform, target, binary, run: () => prepareWorkerd(directory, version) };
}

test('places the locked platform executable without running the shim or native bytes', async t => {
  const f = await fixture(t), receipt = await f.run();
  assert.deepEqual(await readFile(f.target), elf());
  assert.deepEqual(receipt, { schema: 1, package: 'workerd', version, platformPackage, sha256: createHash('sha256').update(elf()).digest('hex'), bytes: 64, directNative: true, downloaded: false, executed: false });
  assert.deepEqual(await readdir(join(f.directory, 'bin')), ['workerd']);
});

test('replacing a package-store hardlink preserves the original shim bytes', async t => {
  const f = await fixture(t), stored = join(f.root, 'store-shim'), before = await readFile(f.target);
  await link(f.target, stored); await f.run(); assert.deepEqual(await readFile(stored), before);
});

for (const [name, change] of [
  ['missing platform package', f => rm(f.platform, { recursive: true })],
  ['wrong platform version', f => writeFile(join(f.platform, 'package.json'), JSON.stringify({ name: platformPackage, version: '0.0.0', os: ['linux'], cpu: ['arm64'] }))],
  ['unlocked optional version', f => writeFile(join(f.directory, 'package.json'), JSON.stringify({ name: 'workerd', version, optionalDependencies: { [platformPackage]: '*' } }))],
  ['wrong architecture', f => { const bytes = elf(); bytes.writeUInt16LE(62, 18); return writeFile(f.binary, bytes); }],
  ['non-executable binary', f => chmod(f.binary, 0o644)],
  ['Node fallback shim', f => writeFile(f.binary, '#!/usr/bin/env node\nthrow Error("must not run")\n')],
]) test(`refuses ${name} without replacing the installed shim`, async t => {
  const f = await fixture(t), before = await readFile(f.target); await change(f);
  await assert.rejects(f.run(), /Locked Linux arm64 workerd input is unavailable/);
  assert.deepEqual(await readFile(f.target), before);
});

test('a target file link cannot redirect placement outside the package', async t => {
  const f = await fixture(t), other = join(f.root, 'outside'); await writeFile(other, 'keep');
  await rm(f.target); await symlink(other, f.target);
  await assert.rejects(f.run(), /Locked Linux arm64 workerd input is unavailable/); assert.equal(await readFile(other, 'utf8'), 'keep');
});

test('an unverified pending file is preserved instead of overwritten', async t => {
  const f = await fixture(t), before = await readFile(f.target); await writeFile(f.target + '.fogd-native.pending', 'keep');
  await assert.rejects(f.run(), /Locked Linux arm64 workerd input is unavailable/);
  assert.deepEqual(await readFile(f.target), before); assert.equal(await readFile(f.target + '.fogd-native.pending', 'utf8'), 'keep');
});

test('the recipe resolves workerd to the placed native file rather than a package-manager wrapper', async t => {
  const f = await fixture(t);
  const wrapper = join(f.root, 'node_modules/.bin'); await mkdir(wrapper, { recursive: true });
  await writeFile(join(wrapper, 'workerd'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  await f.run();
  const recipe = await readFile(new URL('../../../docker/runtime-source.Dockerfile', import.meta.url), 'utf8');
  const declared = /^ENV PATH="(.+)"$/m.exec(recipe)?.[1];
  assert.ok(declared, 'recipe must declare executable resolution');
  const path = declared.replace('/opt/pnpm/node_modules/.bin', join(f.root, 'tools'))
    .replace('/app/packages/runtime/node_modules/workerd', f.directory).replace('${PATH}', wrapper + ':' + process.env.PATH);
  const selected = execFileSync('/bin/sh', ['-c', 'command -v workerd'], { env: { PATH: path }, encoding: 'utf8' }).trim();
  assert.equal(selected, f.target);
  assert.deepEqual(await readFile(selected), elf());
});
