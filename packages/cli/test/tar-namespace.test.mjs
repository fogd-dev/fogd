import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tarNamespace } from '../src/recovery/tar-namespace.mjs';
import { fingerprint } from '../src/recovery/bundle.mjs';
import { gnuTar } from './fixtures/durable-data-transport.mjs';

const namespace = 'fogd/slots/slot-1', refused = { code: 'ARCHIVE_NAMESPACE_REFUSED' };
async function fixture(t) {
  const root = await mkdtemp('/tmp/fogd-tar-namespace-'); t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), selected = join(source, namespace), archive = join(root, 'bucket.tar');
  await mkdir(join(selected, 'fogd-owner.json'), { recursive: true });
  await mkdir(join(source, 'fogd/slots/slot-2'), { recursive: true });
  await mkdir(join(source, 'fogd/slots/slot-10'), { recursive: true });
  await writeFile(join(selected, 'fogd-owner.json/xl.meta'), 'alpha-owner');
  await writeFile(join(source, 'fogd/slots/slot-2/peer'), 'peer-original');
  await writeFile(join(source, 'fogd/slots/slot-10/neighbor'), 'not-alpha');
  const pack = () => execFileSync(gnuTar, ['--format=gnu', '--numeric-owner', '-cpf', archive, '-C', source, '.']);
  const read = async () => tarNamespace(archive, namespace, await fingerprint(archive));
  return { root, source, selected, archive, pack, read };
}

test('namespace evidence stays identical when only another app or adjacent prefix changes', async t => {
  const f = await fixture(t); f.pack(); const before = await f.read();
  await writeFile(join(f.source, 'fogd/slots/slot-2/peer'), 'peer-updated');
  await writeFile(join(f.source, 'fogd/slots/slot-10/neighbor'), 'neighbor-updated'); f.pack();
  const after = await f.read();
  assert.deepEqual(after, before);
  assert.deepEqual(after.members.map(row => row.path), ['', 'fogd-owner.json', 'fogd-owner.json/xl.meta']);
  assert.equal(after.members[2].bytes, 11);
});
test('namespace evidence changes when retained app bytes change', async t => {
  const f = await fixture(t); f.pack(); const before = await f.read();
  await writeFile(join(f.selected, 'fogd-owner.json/xl.meta'), 'changed-app'); f.pack();
  const after = await f.read();
  assert.notDeepEqual(after.members, before.members);
});
test('GNU long names preserve exact member identity without extraction', async t => {
  const f = await fixture(t), name = 'native-cell-'.repeat(15); await mkdir(join(f.selected, name));
  await writeFile(join(f.selected, name, 'xl.meta'), 'long-path-data'); f.pack();
  const result = await f.read();
  assert.equal(result.members.find(row => row.path === name + '/xl.meta').bytes, 14);
  assert.deepEqual((await readFile(join(f.selected, name, 'xl.meta'))).toString(), 'long-path-data');
});
test('a trusted fingerprint mismatch refuses before interpreting namespace bytes', async t => {
  const f = await fixture(t); f.pack();
  await assert.rejects(tarNamespace(f.archive, namespace, { ...await fingerprint(f.archive), sha256: '0'.repeat(64) }), refused);
});
test('invalid header checksums refuse even when the whole archive fingerprint matches', async t => {
  const f = await fixture(t); f.pack(); const bytes = await readFile(f.archive); bytes[0] ^= 1; await writeFile(f.archive, bytes);
  await assert.rejects(f.read(), refused);
});
test('a missing end-of-archive marker refuses despite matching content fingerprint', async t => {
  const f = await fixture(t); f.pack(); const bytes = await readFile(f.archive);
  const contentEnd = Math.ceil((bytes.findLastIndex(byte => byte !== 0) + 1) / 512) * 512;
  await writeFile(f.archive, bytes.subarray(0, contentEnd + 512));
  await assert.rejects(f.read(), refused);
});
test('a namespace missing from the archive cannot count as retained empty data', async t => {
  const f = await fixture(t); f.pack();
  await assert.rejects(tarNamespace(f.archive, 'fogd/slots/missing', await fingerprint(f.archive)), refused);
});
test('duplicate canonical paths refuse rather than selecting a last archive member', async t => {
  const f = await fixture(t); f.pack();
  execFileSync(gnuTar, ['-rpf', f.archive, '-C', f.source, './fogd/slots/slot-1/fogd-owner.json/xl.meta']);
  await assert.rejects(f.read(), refused);
});
test('an unsafe path anywhere in a bucket archive refuses before extraction', async t => {
  const f = await fixture(t);
  execFileSync(gnuTar, ['--format=gnu', '--transform=s|fogd/slots/slot-2|../escape|', '-cpf', f.archive, '-C', f.source, '.']);
  await assert.rejects(f.read(), refused);
});
test('a symlink outside the selected namespace refuses', async t => {
  const f = await fixture(t); await symlink('../slot-1', join(f.source, 'fogd/slots/slot-2/alias')); f.pack();
  await assert.rejects(f.read(), refused);
});
test('a hardlink outside the selected namespace refuses', async t => {
  const f = await fixture(t); await link(join(f.selected, 'fogd-owner.json/xl.meta'), join(f.source, 'fogd/slots/slot-2/alias')); f.pack();
  await assert.rejects(f.read(), refused);
});
test('PAX metadata refuses rather than silently changing following member identity', async t => {
  const f = await fixture(t); execFileSync(gnuTar, ['--format=pax', '-cpf', f.archive, '-C', f.source, '.']);
  await assert.rejects(f.read(), refused);
});
test('a named pipe supplied as an archive refuses without waiting for a writer', async t => {
  const f = await fixture(t); execFileSync('mkfifo', [f.archive]);
  await assert.rejects(tarNamespace(f.archive, namespace, { bytes: 1024, sha256: 'a'.repeat(64) }), refused);
});
test('a leading UTF-8 byte-order mark remains part of a member name instead of impersonating a namespace', async t => {
  const f = await fixture(t), alias = '\ufefffogd';
  await mkdir(join(f.source, alias, 'slots/slot-1/fogd-owner.json'), { recursive: true });
  await writeFile(join(f.source, alias, 'slots/slot-1/fogd-owner.json/xl.meta'), 'foreign-owner');
  execFileSync(gnuTar, ['--format=gnu', '-cpf', f.archive, '-C', f.source, alias]);
  await assert.rejects(f.read(), refused);
});
