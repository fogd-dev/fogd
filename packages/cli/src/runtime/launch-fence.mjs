import { constants } from 'node:fs';
import { open, lstat, rename, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindHostDirectory, hostDirectoryMessage, checkHostDirectory, syncHostDirectory } from './host-directory.mjs';

// A launch fence is local CLI exclusion only: it refuses concurrent or crashed launches and stops
// until an operator inspects the installation. It is not proof against privileged writers.
// Launch and stop share one marker so each excludes the other; release is allowed only in the first or last phase.
const MARKER = 'launch.pending.json', SIZE = 512;
const LAUNCH = { noun: 'launch', phases: ['checking', 'starting', 'preflight', 'ingress', 'complete'] };
const STOP = { noun: 'stop', phases: ['checking', 'stopping', 'complete'], fields: { operation: 'stop' } };
const HOST = { noun: 'host operation', phases: ['checking', 'writing', 'complete'], fields: { operation: 'host' } };
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export class LaunchFenceError extends Error {
  constructor(code, message) { super(message); this.name = 'LaunchFenceError'; this.code = code; }
}
const fail = (code, message) => { throw new LaunchFenceError(code, message); };
const uncertain = () => new LaunchFenceError('FENCE_UNCERTAIN', 'Launch fence state is uncertain; keep the installation stopped and inspect it manually');

const bindDirectory = directory => bindHostDirectory(directory).catch(error => fail('FENCE_DIRECTORY', hostDirectoryMessage('Launch fence', error)));
const checkDirectory = bound => checkHostDirectory(bound).catch(() => { throw uncertain(); });
const syncDirectory = bound => syncHostDirectory(bound).catch(() => { throw uncertain(); });
const encode = record => {
  const buffer = Buffer.alloc(SIZE, ' '), text = JSON.stringify(record);
  buffer.write(text); buffer[SIZE - 1] = 0x0a; return buffer;
};
const owned = (info, identity) => info.isFile() && info.dev === identity.dev && info.ino === identity.ino &&
  info.nlink === 1 && (info.mode & 0o7777) === 0o600 && info.uid === process.geteuid() && info.size === SIZE;

export const acquireLaunchFence = (directory, identity) => acquire(directory, identity, LAUNCH);
export const acquireStopFence = (directory, identity) => acquire(directory, identity, STOP);
export const acquireHostOperationFence = (directory, identity) => acquire(directory, identity, HOST);

// Presence alone refuses, including torn files, directories and symlinks. This
// observation is exclusion only when the caller already owns its own fences.
export async function assertNoLaunchFence(directory) {
  try { await lstat(join(directory, MARKER)); }
  catch (error) { if (error.code === 'ENOENT') return; throw uncertain(); }
  fail('FENCE_EXISTS', 'A related installation has a pending operation; keep related installations stopped and inspect its marker');
}

async function acquire(directory, { project, installation } = {}, { noun, phases, fields }) {
  if (!NAME.test(project ?? '') || !NAME.test(installation ?? '')) fail('FENCE_IDENTITY', 'Launch fence requires valid project and installation names');
  const bound = await bindDirectory(directory), path = join(bound.canonical, MARKER);
  const record = { schema: 1, ...fields, project, installation, id: randomUUID(), phase: phases[0] };
  let handle;
  try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') fail('FENCE_EXISTS', 'Another launch or stop is pending or an earlier one did not finish; inspect the installation before removing its launch marker');
    fail('FENCE_DIRECTORY', 'Cannot create the launch fence');
  }
  // From here on the marker exists; any failure leaves it in place to keep refusing launches and stops.
  let identity;
  try {
    await handle.chmod(0o600); await handle.write(encode(record), 0, SIZE, 0); await handle.sync();
    const info = await handle.stat(); identity = { dev: info.dev, ino: info.ino };
  } catch { throw uncertain(); }
  finally { await handle.close().catch(() => {}); }
  try { await syncDirectory(bound); await checkDirectory(bound); } catch { throw uncertain(); }

  let latched = false;
  // Every operation runs once; any error latches the fence so callers cannot retry automatically.
  const guarded = (work, final = false) => async (...args) => {
    if (latched) fail('FENCE_LATCHED', 'Launch fence is latched or already released; inspect the installation manually');
    latched = true;
    try { const result = await work(...args); latched = final; return result; }
    catch (error) { throw error instanceof LaunchFenceError ? error : uncertain(); }
  };
  // Opens the marker and proves it is still exactly the inode and content this attempt created.
  const verified = async flags => {
    await checkDirectory(bound);
    const file = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!owned(await file.stat(), identity)) throw uncertain();
      const buffer = Buffer.alloc(SIZE);
      if ((await file.read(buffer, 0, SIZE, 0)).bytesRead !== SIZE || !buffer.equals(encode(record))) throw uncertain();
      return file;
    } catch (error) { await file.close(); throw error; }
  };

  return {
    record: guarded(async phase => {
      if (phases.indexOf(phase) !== phases.indexOf(record.phase) + 1) fail('FENCE_PHASE', `The ${noun} phases must advance one checkpoint at a time`);
      const file = await verified(constants.O_RDWR);
      // A single fixed-size write on the verified inode, never a path rename,
      // so an external replacement is never overwritten; a torn write still leaves a refusing marker.
      try { await file.write(encode({ ...record, phase }), 0, SIZE, 0); await file.sync(); }
      finally { await file.close(); }
      record.phase = phase;
      await syncDirectory(bound); await checkDirectory(bound);
    }),
    release: guarded(async () => {
      if (record.phase !== phases[0] && record.phase !== phases.at(-1)) fail('FENCE_ACTIVE', `A started ${noun} cannot release its fence; inspect the installation manually`);
      await (await verified(constants.O_RDONLY)).close();
      // Move aside instead of unlinking by path so a racing replacement is preserved, never deleted.
      const aside = join(bound.canonical, `.${MARKER}.${randomUUID()}.released`);
      await rename(path, aside);
      if (!owned(await lstat(aside), identity)) { await link(aside, path).then(() => unlink(aside)).catch(() => {}); throw uncertain(); }
      await unlink(aside); await syncDirectory(bound); await checkDirectory(bound);
    }, true),
  };
}
