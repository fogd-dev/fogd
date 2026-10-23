import { isDeepStrictEqual } from 'node:util';

const counter = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
const keys = (value, expected) => value && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());
export function decodeSpaceSample(text, count) {
  if (Buffer.byteLength(text) > 65536) throw new Error('Filesystem observation exceeds its size bound');
  let value; try { value = JSON.parse(text); } catch { throw new Error('Cannot decode filesystem observation'); }
  if (!keys(value, ['mounts', 'filesystems']) || !Array.isArray(value.mounts) || !Array.isArray(value.filesystems) || value.mounts.length !== count || !value.filesystems.length || value.filesystems.length > count) throw new Error('Incomplete filesystem observation');
  const filesystems = value.filesystems.map(filesystemSpace), ids = new Set(filesystems.map(row => row.id));
  if (ids.size !== filesystems.length || new Set(filesystems.map(row => row.device)).size !== filesystems.length) throw new Error('Duplicate observed filesystem');
  const indexes = value.mounts.map(row => {
    if (!keys(row, ['index', 'filesystem']) || !Number.isInteger(row.index) || row.index < 0 || row.index >= count || !ids.has(row.filesystem)) throw new Error('Invalid observed volume mapping');
    return row.index;
  });
  if (new Set(indexes).size !== count || new Set(value.mounts.map(row => row.filesystem)).size !== ids.size) throw new Error('Incomplete observed volume mapping');
  return { mounts: value.mounts, filesystems };
}
export function filesystemSpace(value) {
  if (!keys(value, ['id', 'device', 'type', 'observedAt', 'blockBytes', 'fragmentBytes', 'blocks', 'freeBlocks', 'availableBlocks', 'inodes', 'freeInodes']) ||
    !/^filesystem-[1-9][0-9]*$/.test(value.id) || !counter(value.device) || typeof value.type !== 'string' || !/^-?[0-9]{1,20}$/.test(value.type) || !validTime(value.observedAt)) throw new Error('Invalid observed filesystem');
  const fields = ['blockBytes', 'fragmentBytes', 'blocks', 'freeBlocks', 'availableBlocks', 'inodes', 'freeInodes'];
  if (!fields.every(key => counter(value[key]))) throw new Error('Invalid filesystem counters');
  const [block, fragment, blocks, free, available, inodes, freeInodes] = fields.map(key => BigInt(value[key]));
  const size = fragment || block;
  if (size === 0n || blocks === 0n || free > blocks || available > free || freeInodes > inodes) throw new Error('Inconsistent filesystem counters');
  return { id: value.id, device: value.device, type: value.type, observedAt: value.observedAt,
    totalBytes: String(size * blocks), freeBytes: String(size * free), availableBytes: String(size * available),
    usedBytes: String(size * (blocks - free)), unavailableFreeBytes: String(size * (free - available)),
    availableBasisPoints: Number(available * 10000n / blocks), totalInodes: String(inodes), freeInodes: String(freeInodes) };
}
function validTime(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
