import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, access, rm, readFile, mkdir, chmod, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRouteRecord, createRouteRecord, readRouteRecord } from '../src/route-record-store.mjs';
import { saveJson } from '../src/store.mjs';
const policy = { installation: 'a'.repeat(64), slots: ['slot-1'] };
const record = { schema: 1, installation: 'a'.repeat(64), revision: '0', routes: [] };
async function directory(t) { const root = await mkdtemp(join(tmpdir(), 'fogd-route-file-')); t.after(() => rm(root, { recursive: true, force: true })); const path = join(root, 'authority'); await mkdir(path); await chmod(path, 0o755); return path; }
test('public route creation uses gateway-readable file permissions', async t => {
  const dir = await directory(t), path = join(dir, 'routes.json');
  await createRouteRecord(path, record, policy);
  assert.equal((await stat(path)).mode & 0o777, 0o644); assert.equal(await readFile(path, 'utf8'), JSON.stringify(record, null, 2));
});
test('public route replacement has canonical bytes and readable permissions', async t => {
  const dir = await directory(t), path = join(dir, 'routes.json'); await createRouteRecord(path, record, policy);
  await writeRouteRecord(path, { routes: [], revision: '1', installation: policy.installation, schema: 1 }, policy);
  assert.equal((await stat(path)).mode & 0o777, 0o644);
  assert.equal(await readFile(path, 'utf8'), JSON.stringify({ schema: 1, installation: 'a'.repeat(64), revision: '1', routes: [] }, null, 2));
});
test('public writer cannot create a missing authority mount directory', async t => {
  const dir = await directory(t), parent = join(dir, 'missing');
  await assert.rejects(writeRouteRecord(join(parent, 'routes.json'), record, policy), { code: 'ENOENT' });
  await assert.rejects(access(parent), { code: 'ENOENT' });
});
test('public create refuses replacement of an existing route file', async t => {
  const dir = await directory(t), path = join(dir, 'routes.json'); await createRouteRecord(path, record, policy);
  await assert.rejects(createRouteRecord(path, { ...record, revision: '1' }, policy), { code: 'EEXIST' });
  assert.equal(JSON.parse(await readFile(path)).revision, '0');
});

test('public writer refuses a directory that the gateway cannot traverse', async t => {
  const dir = await directory(t); await chmod(dir, 0o700);
  await assert.rejects(createRouteRecord(join(dir, 'routes.json'), record, policy), /gateway-traversable/);
  await assert.rejects(access(join(dir, 'routes.json')), { code: 'ENOENT' });
});

for (const [name, bytes] of [['oversized', Buffer.alloc(65537, 32)], ['invalid UTF-8', Buffer.from([0xff])]]) test(`authority reader refuses ${name} files`, async t => {
  const dir = await directory(t), path = join(dir, 'routes.json'); await writeFile(path, bytes);
  await assert.rejects(readRouteRecord(path, policy));
});
test('authority reader refuses a directory in place of its record', async t => {
  const dir = await directory(t), path = join(dir, 'routes.json'); await mkdir(path);
  await assert.rejects(readRouteRecord(path, policy), /Invalid route authority file/);
});
test('private metadata keeps private permissions and replaces the whole record', async t => {
  const dir = await directory(t), path = join(dir, 'private.json'); await saveJson(path, { saved: 'before' });
  const previous = await open(path, 'r'); t.after(() => previous.close());
  await saveJson(path, { saved: 'after' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path)), { saved: 'after' });
  assert.deepEqual(JSON.parse(await previous.readFile()), { saved: 'before' });
});
