import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const refused = () => Object.assign(new Error('Retained namespace archive is unsupported, changed or inconsistent; retain both snapshots'), { code: 'ARCHIVE_NAMESPACE_REFUSED' });
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fileIdentity = ({ dev, ino, mode, nlink, uid, gid, size, mtimeNs, ctimeNs }) => ({ dev, ino, mode, nlink, uid, gid, size, mtimeNs, ctimeNs });
function text(buffer) {
  const end = buffer.indexOf(0);
  if (end !== -1 && buffer.subarray(end).some(byte => byte !== 0)) throw refused();
  return decoder.decode(end === -1 ? buffer : buffer.subarray(0, end));
}
function number(buffer) {
  let result;
  if (buffer[0] === 0x80) result = buffer.subarray(1).reduce((n, byte) => n * 256n + BigInt(byte), 0n);
  else {
    const value = buffer.toString('ascii').replace(/[\0 ]+$/g, '').trimStart();
    if (!/^[0-7]+$/.test(value)) throw refused();
    result = BigInt('0o' + value);
  }
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw refused();
  return Number(result);
}
async function bytes(file, offset, size) {
  const buffer = Buffer.alloc(size), result = await file.read(buffer, 0, size, offset);
  if (result.bytesRead !== size) throw refused();
  return buffer;
}
async function hashRange(file, offset, size) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
  for (let position = offset; position < offset + size;) {
    const length = Math.min(buffer.length, offset + size - position), result = await file.read(buffer, 0, length, position);
    if (!result.bytesRead) throw refused();
    hash.update(buffer.subarray(0, result.bytesRead)); position += result.bytesRead;
  }
  return hash.digest('hex');
}
function pathName(name, directory) {
  const path = name.startsWith('./') ? name.slice(2) : name;
  const normalized = directory && path.endsWith('/') ? path.slice(0, -1) : path;
  if (directory && ['', '.'].includes(normalized)) return '';
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0') || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw refused();
  return normalized;
}
function header(buffer) {
  const checksum = number(buffer.subarray(148, 156)); let sum = 0;
  for (const [index, byte] of buffer.entries()) sum += index >= 148 && index < 156 ? 32 : byte;
  const magic = buffer.subarray(257, 263).toString('ascii');
  if (checksum !== sum || !['ustar\0', 'ustar '].includes(magic)) throw refused();
  const name = text(buffer.subarray(0, 100)), prefix = magic === 'ustar\0' ? text(buffer.subarray(345, 500)) : '';
  return { name: prefix ? `${prefix}/${name}` : name, type: buffer[156], size: number(buffer.subarray(124, 136)),
    mode: number(buffer.subarray(100, 108)), uid: number(buffer.subarray(108, 116)), gid: number(buffer.subarray(116, 124)) };
}
async function trailer(file, offset, size) {
  if (size - offset < 1024 || (size - offset) % 512) throw refused();
  for (let position = offset; position < size; position += 512) if ((await bytes(file, position, 512)).some(byte => byte !== 0)) throw refused();
}
async function longName(file, offset, entry, pending) {
  if (pending !== null || entry.size < 2 || entry.size > 65536) throw refused();
  const value = await bytes(file, offset, entry.size);
  if (value.at(-1) !== 0) throw refused();
  return text(value);
}
function regularEntry(entry, name, seen) {
  if (![0, 48, 53].includes(entry.type) || (entry.type === 53 && entry.size !== 0)) throw refused();
  const directory = entry.type === 53, path = pathName(name, directory);
  if (seen.has(path) || seen.size >= 200000) throw refused();
  seen.add(path);
  return { path, type: directory ? 'directory' : 'file', mode: entry.mode, uid: entry.uid, gid: entry.gid, bytes: entry.size };
}
async function inventory(file, size, namespace) {
  const selected = [], seen = new Set(); let offset = 0, pending = null, nameBytes = 0;
  while (offset + 512 <= size) {
    const buffer = await bytes(file, offset, 512);
    if (buffer.every(byte => byte === 0)) {
      if (pending !== null) throw refused();
      await trailer(file, offset, size); return selected.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    }
    const entry = header(buffer), data = offset + 512, next = data + Math.ceil(entry.size / 512) * 512;
    if (!Number.isSafeInteger(next) || next > size) throw refused();
    if (entry.type === 76) pending = await longName(file, data, entry, pending);
    else {
      const row = regularEntry(entry, pending ?? entry.name, seen); pending = null;
      nameBytes += Buffer.byteLength(row.path); if (nameBytes > 16 * 1024 * 1024) throw refused();
      if (row.path === namespace || row.path.startsWith(namespace + '/')) {
        if (row.type === 'file') row.sha256 = await hashRange(file, data, entry.size);
        selected.push({ ...row, path: row.path === namespace ? '' : row.path.slice(namespace.length + 1) });
      }
    }
    offset = next;
  }
  throw refused();
}

// Reads only regular files. Accepts the GNU/USTAR producer's ordinary files,
// directories and GNU long names; links, sparse files, PAX and duplicate paths
// refuse throughout the archive. No member is extracted or executed.
export async function tarNamespace(path, namespace, expected) {
  let file;
  try {
    if (pathName(namespace, false) !== namespace || !Number.isSafeInteger(expected?.bytes) || expected.bytes < 1024 || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw refused();
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size !== BigInt(expected.bytes) || await hashRange(file, 0, expected.bytes) !== expected.sha256) throw refused();
    const members = await inventory(file, expected.bytes, namespace);
    if (!members.length || members[0].path !== '' || members[0].type !== 'directory') throw refused();
    if (!isDeepStrictEqual(fileIdentity(await file.stat({ bigint: true })), fileIdentity(before)) || await hashRange(file, 0, expected.bytes) !== expected.sha256) throw refused();
    return { namespace, members };
  } catch { throw refused(); }
  finally { await file?.close(); }
}
