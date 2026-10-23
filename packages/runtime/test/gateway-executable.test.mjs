import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertGatewayExecutable } from '../src/gateway-executable.mjs';

function header() {
  const bytes = Buffer.alloc(64); bytes.set([127, 69, 76, 70, 2, 1, 1]); bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(183, 18); return bytes;
}
async function fixture(t, bytes = header()) {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-gateway-executable-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'workerd'); await writeFile(path, bytes, { mode: 0o700 }); return { path, dir };
}
test('executable format check accepts a regular executable Linux arm64 ELF preamble without executing it', async t => {
  const f = await fixture(t); await assertGatewayExecutable(f.path);
});
for (const [name, bytes] of [
  ['Node shim', Buffer.from('#!/usr/bin/env node\nPRIVATE')],
  ['truncated ELF', Buffer.from([127, 69, 76, 70])],
  ['empty file', Buffer.alloc(0)],
]) test(`${name} refuses without executing or exposing file content`, async t => {
  const f = await fixture(t, bytes);
  await assert.rejects(assertGatewayExecutable(f.path), error => error.code === 'GATEWAY_EXECUTABLE_REFUSED' && !error.message.includes('PRIVATE') && !('cause' in error));
});
test('wrong ELF architecture refuses', async t => {
  const bytes = header(); bytes.writeUInt16LE(62, 18); const f = await fixture(t, bytes);
  await assert.rejects(assertGatewayExecutable(f.path), { code: 'GATEWAY_EXECUTABLE_REFUSED' });
});
for (const [name, offset, value] of [['32-bit class', 4, 1], ['big-endian encoding', 5, 2], ['wrong ELF version', 6, 2], ['non-executable ELF type', 16, 1]]) test(`${name} refuses`, async t => {
  const bytes = header(); bytes[offset] = value; const f = await fixture(t, bytes);
  await assert.rejects(assertGatewayExecutable(f.path), { code: 'GATEWAY_EXECUTABLE_REFUSED' });
});
test('executable ELF type is accepted as well as PIE', async t => {
  const bytes = header(); bytes.writeUInt16LE(2, 16); const f = await fixture(t, bytes);
  await assertGatewayExecutable(f.path);
});
test('non-executable native preamble refuses', async t => {
  const f = await fixture(t); await chmod(f.path, 0o600);
  await assert.rejects(assertGatewayExecutable(f.path), { code: 'GATEWAY_EXECUTABLE_REFUSED' });
});
test('symlinked executable refuses instead of accepting a different final target', async t => {
  const f = await fixture(t), alias = join(f.dir, 'alias'); await symlink(f.path, alias);
  await assert.rejects(assertGatewayExecutable(alias), { code: 'GATEWAY_EXECUTABLE_REFUSED' });
});
test('missing executable and directory refuse', async t => {
  const f = await fixture(t);
  await assert.rejects(assertGatewayExecutable(join(f.dir, 'missing')), { code: 'GATEWAY_EXECUTABLE_REFUSED' });
  await assert.rejects(assertGatewayExecutable(f.dir), { code: 'GATEWAY_EXECUTABLE_REFUSED' });
});
