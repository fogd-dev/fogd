import test from 'node:test';
import assert from 'node:assert/strict';
import { filesystemSpace, decodeSpaceSample } from '../src/storage/model.mjs';

const filesystem = () => ({ id: 'filesystem-1', device: '2049', type: '61267', observedAt: '2026-10-23T02:00:00.000Z',
  blockBytes: '4096', fragmentBytes: '0', blocks: '1000', freeBlocks: '200', availableBlocks: '100', inodes: '500', freeInodes: '400' });
test('space distinguishes used, free, available and reserved blocks without double counting', () => {
  assert.deepEqual(filesystemSpace(filesystem()), { id: 'filesystem-1', device: '2049', type: '61267', observedAt: '2026-10-23T02:00:00.000Z',
    totalBytes: '4096000', freeBytes: '819200', availableBytes: '409600', usedBytes: '3276800', unavailableFreeBytes: '409600', availableBasisPoints: 1000, totalInodes: '500', freeInodes: '400' });
});
test('capacity uses the fundamental fragment size when it differs from transfer block size', () => {
  const result = filesystemSpace({ ...filesystem(), fragmentBytes: '512' });
  assert.equal(result.totalBytes, '512000'); assert.equal(result.freeBytes, '102400');
  assert.equal(result.availableBytes, '51200'); assert.equal(result.usedBytes, '409600');
  assert.equal(result.unavailableFreeBytes, '51200');
});
test('large filesystem sizes remain exact decimal bytes rather than unsafe JSON numbers', () => {
  const result = filesystemSpace({ ...filesystem(), blockBytes: '4096', blocks: '9007199254740993', freeBlocks: '0', availableBlocks: '0' });
  assert.equal(result.totalBytes, '36893488147419107328'); assert.equal(result.availableBasisPoints, 0);
});
test('multiple volumes reference one observed filesystem rather than multiplying capacity', () => {
  const result = decodeSpaceSample(JSON.stringify({ mounts: [{ index: 0, filesystem: 'filesystem-1' }, { index: 1, filesystem: 'filesystem-1' }], filesystems: [filesystem()] }), 2);
  assert.equal(result.filesystems.length, 1); assert.equal(result.filesystems[0].totalBytes, '4096000');
  assert.deepEqual(result.mounts, [{ index: 0, filesystem: 'filesystem-1' }, { index: 1, filesystem: 'filesystem-1' }]);
});
for (const change of [
  { blocks: '0' }, { blockBytes: '0' }, { blocks: '100', freeBlocks: '101' }, { freeBlocks: '100', availableBlocks: '101' },
  { inodes: '3', freeInodes: '4' }, { availableBlocks: '-1' }, { blocks: 1000 }, { blocks: '01' }, { blocks: '9'.repeat(21) },
  { observedAt: 'not-a-date' }, { device: 'private-path' }, { privateData: 'must-not-print' },
]) test(`invalid filesystem counters or extra fields refuse: ${JSON.stringify(change)}`, () => {
  assert.throws(() => filesystemSpace({ ...filesystem(), ...change }), /Invalid|Inconsistent/);
});
for (const [name, mounts, systems, count] of [
  ['missing volume', [{ index: 0, filesystem: 'filesystem-1' }], [filesystem()], 2],
  ['duplicate volume', [{ index: 0, filesystem: 'filesystem-1' }, { index: 0, filesystem: 'filesystem-1' }], [filesystem()], 2],
  ['unknown filesystem', [{ index: 0, filesystem: 'filesystem-2' }], [filesystem()], 1],
  ['unused filesystem', [{ index: 0, filesystem: 'filesystem-1' }, { index: 1, filesystem: 'filesystem-1' }], [filesystem(), { ...filesystem(), id: 'filesystem-2', device: '2050' }], 2],
  ['duplicate device', [{ index: 0, filesystem: 'filesystem-1' }, { index: 1, filesystem: 'filesystem-2' }], [filesystem(), { ...filesystem(), id: 'filesystem-2' }], 2],
]) test(`incomplete or ambiguous helper inventory refuses: ${name}`, () => {
  assert.throws(() => decodeSpaceSample(JSON.stringify({ mounts, filesystems: systems }), count), /Incomplete|Duplicate|Invalid/);
});
test('malformed and oversized output never becomes a report', () => {
  assert.throws(() => decodeSpaceSample('private-invalid-json', 1), /Cannot decode filesystem observation/);
  assert.throws(() => decodeSpaceSample('x'.repeat(65537), 1), /size bound/);
});
