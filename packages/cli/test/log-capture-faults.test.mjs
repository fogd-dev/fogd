import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureProcess } from '../src/logs/capture.mjs';

async function fixture(t) {
  const dir = await fsp.mkdtemp(join(tmpdir(), 'fogd-log-io-')); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return { stdout: join(dir, 'out.log'), stderr: join(dir, 'err.log'), pid: join(dir, 'child.pid') };
}
async function withFileBoundary(path, configure, work) {
  const original = fsp.open;
  fsp.open = async (...args) => { const handle = await original(...args); if (args[0] === path) configure(handle); return handle; };
  syncBuiltinESMExports();
  try { return await work(); }
  finally { fsp.open = original; syncBuiltinESMExports(); }
}
const run = paths => captureProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(paths.pid)}, String(process.pid)); process.stdout.write('private-data')`], paths);
const storageFailure = error => error.code === 'CAPTURE_STORAGE' && !error.message.includes('private-data');
async function childClosed(paths) {
  const pid = Number(await fsp.readFile(paths.pid, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}

test('short filesystem writes retain every byte before reporting a complete capture', async t => {
  const paths = await fixture(t);
  const result = await withFileBoundary(paths.stdout, handle => {
    const write = handle.write.bind(handle); handle.write = (buffer, offset, length) => write(buffer, offset, Math.min(length, 2));
  }, () => run(paths));
  assert.equal(result.status, 'captured'); assert.equal(result.stdoutBytes, 12);
  assert.equal(await fsp.readFile(paths.stdout, 'utf8'), 'private-data'); await childClosed(paths);
});

test('a write failure after real partial output retains the prefix and cannot report captured', async t => {
  const paths = await fixture(t);
  await withFileBoundary(paths.stdout, handle => {
    const write = handle.write.bind(handle); let first = true;
    handle.write = async (buffer, offset, length) => {
      if (!first) throw Object.assign(new Error('private filesystem diagnostic'), { code: 'EIO' });
      first = false; return write(buffer, offset, Math.min(length, 2));
    };
  }, () => assert.rejects(run(paths), storageFailure));
  assert.equal(await fsp.readFile(paths.stdout, 'utf8'), 'pr'); await childClosed(paths);
});

test('a zero-progress filesystem write fails instead of retrying or reporting captured', async t => {
  const paths = await fixture(t);
  await withFileBoundary(paths.stdout, handle => {
    const write = handle.write.bind(handle); let first = true;
    handle.write = async (...args) => { if (!first) return write(...args); first = false; return { bytesWritten: 0 }; };
  }, () => assert.rejects(run(paths), storageFailure));
  assert.equal((await fsp.stat(paths.stdout)).size, 0); await childClosed(paths);
});

test('a file sync failure retains bytes but refuses a completed capture', async t => {
  const paths = await fixture(t);
  await withFileBoundary(paths.stdout, handle => { handle.sync = async () => { throw new Error('private sync diagnostic'); }; },
    () => assert.rejects(run(paths), storageFailure));
  assert.equal(await fsp.readFile(paths.stdout, 'utf8'), 'private-data'); await childClosed(paths);
});
