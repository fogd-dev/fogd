import test from 'node:test';
import assert from 'node:assert/strict';
import { execute } from '../src/recovery/execute.mjs';

test('recovery command capture bounds actual bytes and never returns truncated success', async () => {
  assert.equal(await execute(process.execPath, ['-e', "process.stdout.write('ok')"], { maxOutputBytes: 2 }), 'ok');
  for (const code of ["process.stdout.write('too large')", "process.stdout.write('éé')"]) {
    await assert.rejects(execute(process.execPath, ['-e', code], { maxOutputBytes: 3 }), /diagnostic output exceeded its limit/);
  }
});
test('a child that keeps writing after the output limit is terminated before capture resolves', async () => {
  const code = "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>process.stdout.write('x'.repeat(65536)),1)";
  await assert.rejects(execute(process.execPath, ['-e', code], { maxOutputBytes: 1024 }), /diagnostic output exceeded its limit/);
});
