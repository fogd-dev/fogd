import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat, access, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureProcess, CaptureStorageError } from '../src/logs/capture.mjs';

const node = process.execPath, SECRET = 'private-container-diagnostic-7c1f';
const FIELDS = ['status', 'stdoutBytes', 'stderrBytes', 'exitCode', 'signal', 'reason'];
async function files(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fogd-log-capture-')); t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, stdout: join(dir, 'stdout.log'), stderr: join(dir, 'stderr.log') };
}
const run = (paths, source, options = {}) => captureProcess(node, ['-e', source], { stdout: paths.stdout, stderr: paths.stderr, ...options });
const mode = async path => (await stat(path)).mode & 0o777;
const fixed = result => { assert.deepEqual(Object.keys(result), FIELDS); assert.ok(!JSON.stringify(result).includes(SECRET)); return result; };

test('binary stdout and stderr bytes are kept separately in new private files', async t => {
  const paths = await files(t), out = Buffer.from([0, 255, 10, 13, 128, 1]), err = Buffer.from([254, 0, 7]);
  const result = fixed(await run(paths, `process.stdout.write(Buffer.from(${JSON.stringify([...out])})); process.stderr.write(Buffer.from(${JSON.stringify([...err])}))`));
  assert.deepEqual(result, { status: 'captured', stdoutBytes: 6, stderrBytes: 3, exitCode: 0, signal: null, reason: null });
  assert.deepEqual(await readFile(paths.stdout), out); assert.deepEqual(await readFile(paths.stderr), err);
  assert.equal(await mode(paths.stdout), 0o600); assert.equal(await mode(paths.stderr), 0o600);
});
test('output of exactly the combined limit is still a complete capture', async t => {
  const paths = await files(t);
  const result = await run(paths, `process.stdout.write('a'.repeat(6)); process.stderr.write('b'.repeat(4))`, { maxBytes: 10 });
  assert.deepEqual(result, { status: 'captured', stdoutBytes: 6, stderrBytes: 4, exitCode: 0, signal: null, reason: null });
});
test('simultaneous oversized streams share one hard cap and stop the child', async t => {
  const paths = await files(t), maxBytes = 65536;
  const result = fixed(await run(paths, `const chunk = Buffer.alloc(1 << 20, 120); process.stdout.write(chunk); process.stderr.write(chunk); setInterval(() => {}, 1000)`, { maxBytes }));
  assert.equal(result.status, 'partial'); assert.equal(result.reason, 'output-limit'); assert.equal(result.exitCode, null);
  assert.equal(result.stdoutBytes + result.stderrBytes, maxBytes);
  assert.equal((await stat(paths.stdout)).size + (await stat(paths.stderr)).size, maxBytes);
});
test('a failing process keeps its private stderr only in the private file and off the terminal', async t => {
  const paths = await files(t), module = new URL('../src/logs/capture.mjs', import.meta.url).href;
  const script = `const { captureProcess } = await import(${JSON.stringify(module)});
    const result = await captureProcess(process.execPath, ['-e', ${JSON.stringify(`process.stderr.write('${SECRET}'); process.exitCode = 3`)}], ${JSON.stringify(paths)});
    process.stdout.write(JSON.stringify(result));`;
  const host = spawn(node, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  host.stdout.on('data', data => { output.stdout += data; }); host.stderr.on('data', data => { output.stderr += data; });
  assert.equal(await new Promise(done => host.once('close', done)), 0);
  assert.ok(!output.stdout.includes(SECRET) && !output.stderr.includes(SECRET));
  assert.deepEqual(fixed(JSON.parse(output.stdout)), { status: 'partial', stdoutBytes: 0, stderrBytes: SECRET.length, exitCode: 3, signal: null, reason: 'process-failed' });
  assert.equal(await readFile(paths.stderr, 'utf8'), SECRET);
});
test('a timed out child is terminated and its partial files are retained', async t => {
  const paths = await files(t);
  const result = await run(paths, `process.stdout.write('ready'); setInterval(() => {}, 1000)`, { timeoutMs: 1000, graceMs: 2000 });
  assert.deepEqual(result, { status: 'partial', stdoutBytes: 5, stderrBytes: 0, exitCode: null, signal: 'SIGTERM', reason: 'timeout' });
  assert.equal(await readFile(paths.stdout, 'utf8'), 'ready'); assert.equal(await mode(paths.stderr), 0o600);
});
test('a child ignoring SIGTERM is killed after the grace period', async t => {
  const paths = await files(t);
  const result = await run(paths, `process.on('SIGTERM', () => process.stdout.write('ignored')); process.stdout.write('ready'); setInterval(() => {}, 1000)`, { timeoutMs: 1000, graceMs: 300 });
  assert.deepEqual(result, { status: 'partial', stdoutBytes: 12, stderrBytes: 0, exitCode: null, signal: 'SIGKILL', reason: 'timeout' });
  assert.equal(await readFile(paths.stdout, 'utf8'), 'readyignored');
});
test('capture waits for the inherited pipes to close, not just for the child to exit', async t => {
  const paths = await files(t);
  // The descendant writes only after its parent exits, observed as end of its stdin pipe.
  const descendant = `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('after-exit'))`;
  const result = await run(paths, `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['pipe', 'inherit', 'inherit'] }); process.stdout.write('before-exit;'); process.exit(0)`, { timeoutMs: 10000 });
  assert.deepEqual(result, { status: 'captured', stdoutBytes: 22, stderrBytes: 0, exitCode: 0, signal: null, reason: null });
  assert.equal(await readFile(paths.stdout, 'utf8'), 'before-exit;after-exit');
});
test('a descendant holding pipes after the child exits is bounded by destroying owned streams', async t => {
  const paths = await files(t);
  const result = await run(paths, `const held = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); process.stdout.write(held.pid + '\\n'); process.exit(0)`, { timeoutMs: 1000, graceMs: 200 });
  const pid = Number((await readFile(paths.stdout, 'utf8')).trim());
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.deepEqual(result, { status: 'partial', stdoutBytes: `${pid}\n`.length, stderrBytes: 0, exitCode: 0, signal: null, reason: 'timeout' });
});
test('a command that cannot start settles without bytes and keeps its empty private files', async t => {
  const paths = await files(t);
  const result = fixed(await captureProcess(join(paths.dir, 'missing-program'), [], paths));
  assert.deepEqual(result, { status: 'unavailable', stdoutBytes: 0, stderrBytes: 0, exitCode: null, signal: null, reason: 'cannot-start' });
  assert.equal((await stat(paths.stdout)).size, 0); assert.equal(await mode(paths.stderr), 0o600);
});
test('existing files and links are never overwritten and the child is never started', async t => {
  const paths = await files(t), started = join(paths.dir, 'started'), target = join(paths.dir, 'target');
  const source = `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'x')`;
  await writeFile(paths.stdout, 'original', { mode: 0o600 });
  await assert.rejects(run(paths, source), CaptureStorageError);
  assert.equal(await readFile(paths.stdout, 'utf8'), 'original'); await assert.rejects(access(paths.stderr), { code: 'ENOENT' });
  const second = { stdout: join(paths.dir, 'kept.log'), stderr: join(paths.dir, 'link.log') };
  await symlink(target, second.stderr);
  await assert.rejects(run(second, source), CaptureStorageError);
  await assert.rejects(access(target), { code: 'ENOENT' }); await assert.rejects(access(started), { code: 'ENOENT' });
  assert.equal(await mode(second.stdout), 0o600);
});
test('invalid options are rejected before any file is created', async t => {
  const paths = await files(t);
  for (const options of [{ ...paths, stderr: paths.stdout }, { ...paths, stderr: `${paths.dir}/./stdout.log` }, { ...paths, stdout: 'stdout.log' },
    { ...paths, maxBytes: 0 }, { ...paths, timeoutMs: 1.5 }, { ...paths, graceMs: -1 }, { ...paths, env: null }, { stdout: paths.stdout }]) {
    await assert.rejects(captureProcess(node, ['-e', ''], options), TypeError);
  }
  await assert.rejects(captureProcess('', [], paths), TypeError); await assert.rejects(captureProcess(node, 'x', paths), TypeError);
  assert.deepEqual(await readdir(paths.dir), []);
});
