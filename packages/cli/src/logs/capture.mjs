import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

// Captures one trusted child's stdout and stderr into new private files under a combined
// byte cap and one deadline. Results carry only fixed fields: no output, command, or error
// detail leaves this module. Files are never overwritten or deleted, even after a failure.
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const MAX_TIMER = 2 ** 31 - 1;

export class CaptureStorageError extends Error {
  constructor() { super('Private log storage failed; partial files were retained'); this.name = 'CaptureStorageError'; this.code = 'CAPTURE_STORAGE'; }
}
const integer = (value, min) => Number.isSafeInteger(value) && value >= min && value <= MAX_TIMER;
const invalid = () => { throw new TypeError('Invalid process capture options'); };

const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const validProgram = (command, args) => text(command) && Array.isArray(args) && args.every(arg => arg === '' || text(arg));
const validPaths = (stdout, stderr) => text(stdout) && text(stderr) && isAbsolute(stdout) && isAbsolute(stderr) && resolve(stdout) !== resolve(stderr);
const validLimits = ({ timeoutMs, maxBytes, graceMs, env }) => integer(timeoutMs, 1) && integer(maxBytes, 1) && integer(graceMs, 1) && Boolean(env) && typeof env === 'object';

// Everything is checked before any file is created or any child is started.
function validate(command, args, options) {
  const { stdout, stderr, timeoutMs = 15000, maxBytes = 1048576, graceMs = 1000, env = process.env } = options || {};
  const valid = { stdout, stderr, timeoutMs, maxBytes, graceMs, env };
  if (!validProgram(command, args) || !validPaths(stdout, stderr) || !validLimits(valid)) invalid();
  return valid;
}

async function create(path) {
  const handle = await open(path, CREATE, 0o600);
  try { await handle.chmod(0o600); } catch (error) { await handle.close().catch(() => {}); throw error; }
  return handle;
}
async function openFiles(options) {
  const out = await create(options.stdout).catch(() => { throw new CaptureStorageError(); });
  try { return [out, await create(options.stderr)]; }
  catch { await out.close().catch(() => {}); throw new CaptureStorageError(); }
}

// Handles short writes; any write failure becomes the fixed storage failure.
async function writeAll(handle, chunk, length, counts, index) {
  for (let offset = 0; offset < length;) {
    const { bytesWritten } = await handle.write(chunk, offset, length - offset);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > length - offset) throw new CaptureStorageError();
    offset += bytesWritten; counts[index] += bytesWritten;
  }
}
// Async iteration pauses the pipe while a write is pending, so memory stays bounded by one chunk.
async function pump(source, handle, state, index) {
  try {
    for await (const chunk of source) {
      const kept = Math.min(chunk.length, state.remaining);
      state.remaining -= kept;
      if (kept) await writeAll(handle, chunk, kept, state.counts, index).catch(() => { state.storage = true; });
      if (state.storage) return state.stop(null);
      if (kept < chunk.length) return state.stop('output-limit');
    }
  } catch { state.incomplete = true; state.stop('process-failed'); }
}

function supervise(child, options) {
  const state = { remaining: options.maxBytes, counts: [0, 0], reason: null, storage: false, incomplete: false, timers: [] };
  const running = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  const signal = name => { if (running()) child.kill(name); };
  state.stop = reason => {
    if (state.stopping) return;
    state.stopping = true; state.reason = reason; signal('SIGTERM');
    // After grace, force the owned child and release pipes a descendant may still hold open.
    state.timers.push(setTimeout(() => { signal('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); }, options.graceMs));
  };
  state.timers.push(setTimeout(() => state.stop('timeout'), options.timeoutMs));
  return state;
}

function outcome(state, code, signal, started) {
  const [stdoutBytes, stderrBytes] = state.counts;
  const exitCode = started ? code : null;
  if (!state.stopping && !state.incomplete && exitCode === 0) return { status: 'captured', stdoutBytes, stderrBytes, exitCode, signal, reason: null };
  const reason = state.reason || (started ? 'process-failed' : 'cannot-start');
  return { status: stdoutBytes + stderrBytes ? 'partial' : 'unavailable', stdoutBytes, stderrBytes, exitCode, signal, reason };
}

async function finish(files, durable) {
  let failed = !durable;
  for (const handle of files) {
    if (durable) await handle.sync().catch(() => { failed = true; });
    await handle.close().catch(() => { failed = true; });
  }
  if (failed) throw new CaptureStorageError();
}

export async function captureProcess(command, args, options) {
  const valid = validate(command, args, options);
  const files = await openFiles(valid);
  let child, state;
  try { child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: valid.env }); }
  catch { await finish(files, true); return { status: 'unavailable', stdoutBytes: 0, stderrBytes: 0, exitCode: null, signal: null, reason: 'cannot-start' }; }
  try {
    state = supervise(child, valid);
    const closed = new Promise(done => child.once('close', (code, signal) => done({ code, signal })));
    // Spawn failures still emit close; this listener only keeps the error private and handled.
    child.on('error', () => {});
    const [{ code, signal }] = await Promise.all([closed, pump(child.stdout, files[0], state, 0), pump(child.stderr, files[1], state, 1)]);
    state.timers.forEach(clearTimeout);
    await finish(files, !state.storage);
    return outcome(state, code, signal, child.pid !== undefined);
  } catch (error) {
    state?.timers.forEach(clearTimeout);
    if (error instanceof CaptureStorageError) throw error;
    await finish(files, false).catch(() => {});
    throw new CaptureStorageError();
  }
}
