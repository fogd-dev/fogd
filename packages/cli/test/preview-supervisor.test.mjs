import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { supervisePreviewProcess } from '../src/preview/supervisor.mjs';

const expiry = milliseconds => new Date(Date.now() + milliseconds).toISOString();
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fogd-preview-process-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, ready: join(directory, 'ready'), late: join(directory, 'late') };
}
async function ready(path) {
  for (let i = 0; i < 200; i++) {
    try { await access(path); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(25);
  }
  throw new Error('Owned preview test child did not become ready');
}
function command(f, ignoreTermination = false) {
  return { executable: process.execPath, args: ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    ${ignoreTermination ? "process.on('SIGTERM', () => {});" : ''}
    writeFileSync(process.argv[1], 'ready');
    setTimeout(() => writeFileSync(process.argv[2], 'late'), 1500);
    setInterval(() => {}, 1000);
  `, f.ready, f.late] };
}

test('an expired preview starts no process and never writes app data', async t => {
  const f = await fixture(t);
  const observed = await supervisePreviewProcess({ ...command(f), expiresAt: expiry(-1) });
  assert.deepEqual(observed, { outcome: 'expired', started: false, childExitConfirmed: true, exitCode: null, signal: null });
  await assert.rejects(access(f.ready), { code: 'ENOENT' });
});

test('expiry stops the owned writer and the same expired deadline cannot start it again', async t => {
  const f = await fixture(t), expiresAt = expiry(500);
  const observed = await supervisePreviewProcess({ ...command(f), expiresAt });
  assert.equal(observed.outcome, 'expired'); assert.equal(observed.childExitConfirmed, true);
  assert.equal(observed.started, true); assert.equal(observed.signal, 'SIGTERM');
  await delay(1600);
  await assert.rejects(access(f.late), { code: 'ENOENT' });
  const retried = await supervisePreviewProcess({ ...command(f), expiresAt });
  assert.equal(retried.outcome, 'expired'); assert.equal(retried.started, false);
});

test('cancellation confirms exit before returning and never restarts the service', async t => {
  const f = await fixture(t), cancellation = new AbortController();
  const running = supervisePreviewProcess({ ...command(f), expiresAt: expiry(30000), signal: cancellation.signal });
  await ready(f.ready); cancellation.abort();
  const observed = await running;
  assert.equal(observed.outcome, 'cancelled'); assert.equal(observed.childExitConfirmed, true);
  assert.equal(observed.signal, 'SIGTERM'); assert.equal(await readFile(f.ready, 'utf8'), 'ready');
  await delay(1600); await assert.rejects(access(f.late), { code: 'ENOENT' });
});

test('a child ignoring graceful termination is force-stopped and confirmed', async t => {
  const f = await fixture(t), cancellation = new AbortController();
  const running = supervisePreviewProcess({ ...command(f, true), expiresAt: expiry(30000), signal: cancellation.signal });
  await ready(f.ready); cancellation.abort();
  const observed = await running;
  assert.equal(observed.outcome, 'cancelled'); assert.equal(observed.childExitConfirmed, true); assert.equal(observed.signal, 'SIGKILL');
  await delay(600); await assert.rejects(access(f.late), { code: 'ENOENT' });
});

test('already cancelled launch starts no child', async t => {
  const f = await fixture(t), cancellation = new AbortController(); cancellation.abort();
  const observed = await supervisePreviewProcess({ ...command(f), expiresAt: expiry(30000), signal: cancellation.signal });
  assert.equal(observed.outcome, 'cancelled'); assert.equal(observed.started, false);
  await assert.rejects(access(f.ready), { code: 'ENOENT' });
});

test('service exit and spawn failure are terminal observations without automatic retry', async t => {
  const normal = await supervisePreviewProcess({ executable: process.execPath, args: ['-e', 'process.exit(17)'], expiresAt: expiry(30000) });
  assert.deepEqual(normal, { outcome: 'exited', started: true, childExitConfirmed: true, exitCode: 17, signal: null });
  const failed = await supervisePreviewProcess({ executable: '/nonexistent-fogd-preview-service', expiresAt: expiry(30000) });
  assert.deepEqual(failed, { outcome: 'start-failed', started: false, childExitConfirmed: true, exitCode: null, signal: null });
});

for (const expiresAt of ['invalid', '2099-01-01T00:00:00.000Z', '2026-10-30']) test(`invalid preview expiry refuses before starting a writer: ${expiresAt}`, async t => {
  const f = await fixture(t); await assert.rejects(supervisePreviewProcess({ ...command(f), expiresAt }), /exact expiry/);
  await assert.rejects(access(f.ready), { code: 'ENOENT' });
});

test('a preview child does not inherit the parent operator environment', async t => {
  const f = await fixture(t), previous = process.env.FOGD_PREVIEW_PARENT_SECRET;
  process.env.FOGD_PREVIEW_PARENT_SECRET = 'parent-only';
  try {
    const observed = await supervisePreviewProcess({ executable: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync(process.argv[1],JSON.stringify(process.env))", f.ready],
      env: Object.assign(Object.create({ FOGD_PREVIEW_PARENT_SECRET: 'inherited' }), { PREVIEW_ONLY: 'fixture' }), expiresAt: expiry(30000) });
    assert.equal(observed.childExitConfirmed, true);
    const provided = JSON.parse(await readFile(f.ready, 'utf8'));
    // Node supplies this OS process metadata on Darwin even with an explicit env.
    if (process.platform === 'darwin') delete provided.__CF_USER_TEXT_ENCODING;
    assert.deepEqual(provided, { PREVIEW_ONLY: 'fixture' });
    const empty = await supervisePreviewProcess({ executable: process.execPath,
      args: ['-e', "require('node:fs').writeFileSync(process.argv[1],JSON.stringify(process.env))", f.ready], expiresAt: expiry(30000) });
    assert.equal(empty.childExitConfirmed, true);
    const omitted = JSON.parse(await readFile(f.ready, 'utf8'));
    if (process.platform === 'darwin') delete omitted.__CF_USER_TEXT_ENCODING;
    assert.deepEqual(omitted, {});
  } finally {
    if (previous === undefined) delete process.env.FOGD_PREVIEW_PARENT_SECRET;
    else process.env.FOGD_PREVIEW_PARENT_SECRET = previous;
  }
});

for (const options of [{ signal: {} }, { env: null }, { env: { PREVIEW: 7 } }]) test(`invalid launch control refuses before child allocation: ${JSON.stringify(options)}`, async t => {
  const f = await fixture(t);
  await assert.rejects(supervisePreviewProcess({ ...command(f), expiresAt: expiry(30000), ...options }), /AbortSignal|environment must be supplied/);
  await assert.rejects(access(f.ready), { code: 'ENOENT' });
});

test('lost child-exit observation remains unconfirmed after termination attempts', async () => {
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const childProcess = createRequire(import.meta.url)('node:child_process');
  const original = childProcess.spawn;
  // No OS process or signal is involved in this observation-loss fault.
  const child = new EventEmitter(); child.pid = 123; child.kill = () => true;
  childProcess.spawn = () => child; syncBuiltinESMExports();
  try {
    const observed = await supervisePreviewProcess({ executable: 'owned-fixture', expiresAt: expiry(20) });
    assert.equal(observed.outcome, 'stop-unconfirmed'); assert.equal(observed.childExitConfirmed, false);
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});
