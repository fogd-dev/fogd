import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindHostDirectory, hostDirectoryMessage, checkHostDirectory, syncHostDirectory } from './host-directory.mjs';

// Enrollment records fence a host installation until its first enrollment finishes.
// Both records are kept permanently so an interrupted enrollment can never look fresh.
// A matched record only lifts this host fence; it never proves physical freshness or
// authorizes execution apart from the native policy, image, and mount checks.
const PENDING = 'enrollment.pending.json', COMPLETE = 'enrollment.complete.json', MAX = 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ['schema', 'id', 'project', 'installation', 'planSha256'];
const EXPECTED = ['project', 'installation', 'planSha256'];
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export class EnrollmentRecordError extends Error {
  constructor(code, message) { super(message); this.name = 'EnrollmentRecordError'; this.code = code; }
}
const fail = (code, message) => { throw new EnrollmentRecordError(code, message); };
const uncertain = () => new EnrollmentRecordError('ENROLLMENT_UNCERTAIN', 'Enrollment state is uncertain; keep the installation stopped and inspect it manually');
const notReady = () => new EnrollmentRecordError('ENROLLMENT_NOT_READY', 'Installation enrollment is incomplete or inconsistent; keep the installation stopped and inspect it manually');
const exists = () => new EnrollmentRecordError('ENROLLMENT_EXISTS', 'An enrollment record already exists; retain it and choose a fresh installation');

const bindDirectory = directory => bindHostDirectory(directory).catch(error => fail('ENROLLMENT_DIRECTORY', hostDirectoryMessage('Enrollment', error)));
const checkDirectory = bound => checkHostDirectory(bound).catch(() => { throw uncertain(); });
const syncDirectory = bound => syncHostDirectory(bound).catch(() => { throw uncertain(); });
const encode = record => Buffer.from(`${JSON.stringify(record)}\n`);
const privateFile = (info, bound) => info.isFile() && info.dev === bound.dev && info.nlink === 1 &&
  (info.mode & 0o7777) === 0o600 && info.uid === process.geteuid() && info.size > 0 && info.size <= MAX;

// Missing entries are null; any other entry, including symlinks and partial files, is present.
async function present(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw uncertain(); }
}
async function readBytes(path, bound) {
  const file = await open(path, READ);
  try {
    const info = await file.stat();
    if (!privateFile(info, bound)) throw notReady();
    const buffer = Buffer.alloc(MAX + 1), { bytesRead } = await file.read(buffer, 0, MAX + 1, 0);
    if (bytesRead !== info.size) throw notReady();
    return { bytes: buffer.subarray(0, bytesRead), dev: info.dev, ino: info.ino };
  } finally { await file.close(); }
}
// Strict UTF-8, exact key order, and byte-for-byte canonical encoding.
function parseRecord(bytes, fields) {
  const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).join() !== fields.join()) throw notReady();
  if (!encode(record).equals(bytes) || !validRecord(record)) throw notReady();
  return record;
}
const validRecord = record => record.schema === 1 && UUID.test(record.id) && NAME.test(record.project) &&
  HEX.test(record.installation) && HEX.test(record.planSha256) && (!('inventoryBinding' in record) || HEX.test(record.inventoryBinding));
async function createRecord(bound, name, record) {
  let handle;
  try { handle = await open(join(bound.canonical, name), CREATE, 0o600); }
  catch (error) { throw error.code === 'EEXIST' ? exists() : uncertain(); }
  // From here on the entry exists; any failure leaves it in place to keep refusing.
  try {
    await handle.chmod(0o600); await handle.writeFile(encode(record)); await handle.sync();
    const info = await handle.stat(); return { dev: info.dev, ino: info.ino };
  } catch { throw uncertain(); }
  finally { await handle.close().catch(() => {}); }
}

export async function beginDurableEnrollment(directory, { project, installation, planSha256 } = {}) {
  if (!NAME.test(project ?? '') || !HEX.test(installation ?? '') || !HEX.test(planSha256 ?? ''))
    fail('ENROLLMENT_IDENTITY', 'Enrollment requires a valid project, installation, and plan digest');
  const bound = await bindDirectory(directory), pendingPath = join(bound.canonical, PENDING);
  if (await present(join(bound.canonical, COMPLETE))) throw exists();
  const record = { schema: 1, id: randomUUID(), project, installation, planSha256 };
  const identity = await createRecord(bound, PENDING, record);
  try {
    await syncDirectory(bound); await checkDirectory(bound);
    if (await present(join(bound.canonical, COMPLETE))) throw uncertain();
  } catch { throw uncertain(); }

  // Proves the pending record is still exactly the inode, owner, mode, and bytes this attempt wrote.
  const verifyPending = async () => {
    await checkDirectory(bound);
    const read = await readBytes(pendingPath, bound);
    if (read.ino !== identity.ino || read.dev !== identity.dev || !read.bytes.equals(encode(record))) throw uncertain();
  };
  let used = false;
  return {
    async complete(inventoryBinding) {
      if (used) fail('ENROLLMENT_LATCHED', 'Enrollment completion already ran or failed; inspect the installation manually');
      used = true;
      if (!HEX.test(inventoryBinding ?? '')) fail('ENROLLMENT_IDENTITY', 'Enrollment completion requires a valid inventory binding');
      const completed = { ...record, inventoryBinding };
      try {
        await verifyPending();
        await createRecord(bound, COMPLETE, completed);
        await syncDirectory(bound); await verifyPending();
      } catch (error) { throw error.code === 'ENROLLMENT_IDENTITY' ? error : uncertain(); }
      return Object.freeze(completed);
    },
  };
}

function checkExpected(expected) {
  if (expected === undefined) return {};
  if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).some(key => !EXPECTED.includes(key)))
    fail('ENROLLMENT_EXPECTED', 'Expected enrollment may only name project, installation, and planSha256');
  return expected;
}
async function readRecord(bound, name, fields) {
  try {
    const path = join(bound.canonical, name), before = await lstat(path), read = await readBytes(path, bound);
    if (before.ino !== read.ino || before.dev !== read.dev) throw notReady();
    return parseRecord(read.bytes, fields);
  } catch { throw notReady(); }
}

// Returns null when no enrollment marker exists (legacy installation); otherwise the completed record.
export async function assertDurableEnrollmentReady(directory, expected) {
  const want = checkExpected(expected), bound = await bindDirectory(directory);
  const markers = [await present(join(bound.canonical, PENDING)), await present(join(bound.canonical, COMPLETE))];
  if (!markers[0] && !markers[1]) { await checkDirectory(bound); return null; }
  const pending = await readRecord(bound, PENDING, FIELDS);
  const completed = await readRecord(bound, COMPLETE, [...FIELDS, 'inventoryBinding']);
  if (FIELDS.some(key => pending[key] !== completed[key]) || EXPECTED.some(key => key in want && want[key] !== completed[key])) throw notReady();
  await checkDirectory(bound);
  return Object.freeze(completed);
}
