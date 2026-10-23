import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBuildOutputs, assertBuildOutputs } from '../../../scripts/runtime-build-output.mjs';
import { programInventory } from '../src/runtime/program-inventory.mjs';
import { execFileSync } from 'node:child_process';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const version = '1.20261016.1', platformPackage = '@cloudflare/workerd-linux-arm64';
const fingerprint = bytes => ({ sha256: hash(bytes), bytes: bytes.length });
function elf() { const b = Buffer.alloc(64); b.set([127, 69, 76, 70, 2, 1, 1]); b.writeUInt16LE(3, 16); b.writeUInt16LE(183, 18); return b; }
const readerScript = f => `console.log(JSON.stringify(await (${readBuildOutputs.toString()})(${JSON.stringify(f.root)},${JSON.stringify(f.bin)},${JSON.stringify(f.records)},${programInventory.toString()})));`;

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'fogd-build-output-')); t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'app'), bin = join(base, 'bin'), records = join(base, 'records');
  const programs = { 'packages/runtime/package.json': '{}', 'packages/platform/package.json': '{}', 'packages/runtime/src/serve.mjs': 'export const a = 1;', 'packages/platform/src/main.mjs': 'export const b = 2;' };
  const files = { ...programs, 'packages/runtime/node_modules/workerd/bin/workerd': elf() };
  for (const [path, bytes] of Object.entries(files)) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), bytes, { mode: 0o755 }); }
  await mkdir(join(root, 'packages/platform/node_modules')); await mkdir(bin); await mkdir(records);
  const supervisor = Buffer.from('#!/bin/sh\nexit 97\n');
  await writeFile(join(bin, 'celld'), elf(), { mode: 0o755 }); await writeFile(join(bin, 'celld-supervisor'), supervisor, { mode: 0o755 });
  const nativeInputs = JSON.parse(await readFile(new URL('../../../docker/runtime-native-inputs.json', import.meta.url), 'utf8'));
  const assets = { archive: { file: 'rusty-v8.a.gz', sha256: nativeInputs.archive.sha256, bytes: nativeInputs.archive.bytes }, bindings: { file: 'rusty-v8-bindings.rs', sha256: nativeInputs.bindings.sha256, bytes: nativeInputs.bindings.bytes } };
  const acquired = { schema: 1, kind: 'verified-native-inputs', target: nativeInputs.target, v8Version: nativeInputs.v8Version, v8CrateSha256: nativeInputs.v8CrateSha256, assets, compiled: false, qualified: false };
  const workerdInput = { schema: 1, package: 'workerd', version, platformPackage, ...fingerprint(elf()), directNative: true, downloaded: false, executed: false };
  const toolchain = 'rustc 1.98.1 (synthetic)\nhost: aarch64-unknown-linux-gnu\ncargo 1.98.1 (synthetic)\n';
  await writeFile(join(records, 'native-inputs.json'), JSON.stringify(acquired)); await writeFile(join(records, 'workerd-input.json'), JSON.stringify(workerdInput));
  await writeFile(join(records, 'native-toolchain.txt'), toolchain);
  const sourceFiles = Object.fromEntries(Object.entries(programs).map(([path, text]) => [path, hash(text)]));
  return { root, bin, records, expected: { sourceFiles, supervisorSha256: hash(supervisor), nativeInputs, workerdVersion: version },
    observed: { sourceFiles, celld: fingerprint(elf()), supervisor: fingerprint(supervisor), workerd: fingerprint(elf()), nativeInputs: acquired, workerdInput, toolchain },
    read: () => readBuildOutputs(root, bin, records, programInventory) };
}

test('reads native fingerprints, exact production sources and input records without executing programs', async t => {
  const f = await fixture(t), actual = await f.read();
  assert.deepEqual(actual, f.observed); assertBuildOutputs(actual, f.expected);
  const serialized = execFileSync(process.execPath, ['--input-type=module', '-e', readerScript(f)], { timeout: 10000, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(serialized), f.observed);
});

for (const [name, change] of [
  ['a native Node shim', f => writeFile(join(f.bin, 'celld'), '#!/usr/bin/env node\nthrow Error("must not execute")\n')],
  ['wrong native architecture', f => { const b = elf(); b.writeUInt16LE(62, 18); return writeFile(join(f.bin, 'celld'), b); }],
  ['a non-executable supervisor', f => chmod(join(f.bin, 'celld-supervisor'), 0o644)],
  ['a linked native output', async f => { await rm(join(f.bin, 'celld')); await symlink(join(f.bin, 'celld-supervisor'), join(f.bin, 'celld')); }],
  ['an oversized input record', f => writeFile(join(f.records, 'native-inputs.json'), 'x'.repeat(65537))],
  ['a linked input record', async f => { await rm(join(f.records, 'native-inputs.json')); await symlink(join(f.records, 'workerd-input.json'), join(f.records, 'native-inputs.json')); }],
  ['a private qualification directory', f => mkdir(join(f.root, 'qualification'))],
]) test(`refuses ${name} instead of recording a successful image`, async t => {
  const f = await fixture(t); await change(f); await assert.rejects(f.read());
});

test('a FIFO input record refuses without waiting for a writer', async t => {
  const f = await fixture(t), path = join(f.records, 'native-inputs.json'); await rm(path); execFileSync('mkfifo', [path]);
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', readerScript(f)], { timeout: 3000, stdio: 'pipe' }), error =>
    /bounded regular file/.test(error.stderr?.toString()) && error.signal !== 'SIGTERM');
});

test('withholds output when actual programs, receipts or toolchain differ from declared inputs', async t => {
  const f = await fixture(t);
  for (const change of [
    value => { value.sourceFiles.extra = 'a'.repeat(64); }, value => { value.supervisor.sha256 = 'b'.repeat(64); },
    value => { value.workerdInput.sha256 = 'c'.repeat(64); }, value => { value.workerdInput.version = '0.0.0'; },
    value => { value.nativeInputs.assets.archive.sha256 = 'd'.repeat(64); }, value => { value.nativeInputs.qualified = true; },
    value => { value.toolchain = 'rustc 0.0.0 (synthetic)\nhost: aarch64-unknown-linux-gnu\n'; },
    value => { value.celld.bytes = 0; }, value => { value.celld.extra = 'withheld'; }, value => { value.extra = 'withheld'; },
  ]) { const observed = structuredClone(f.observed); change(observed); assert.throws(() => assertBuildOutputs(observed, f.expected), /differ from/); }
});
