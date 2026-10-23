import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, chmod, symlink, stat, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beginDurableEnrollment, assertDurableEnrollmentReady, EnrollmentRecordError } from '../src/runtime/enrollment-record.mjs';

const identity = { project: 'fogd-demo', installation: 'a'.repeat(64), planSha256: 'b'.repeat(64) };
const binding = 'c'.repeat(64);
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fogd-enroll-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'installation'); await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700);
  return { root, directory, pending: join(directory, 'enrollment.pending.json'), complete: join(directory, 'enrollment.complete.json') };
}
const refuses = (promise, code) => assert.rejects(promise, error => error instanceof EnrollmentRecordError && error.code === code &&
  !error.cause && !error.message.includes('/') && !error.message.includes('a'.repeat(64)));
const record = async path => JSON.parse(await readFile(path, 'utf8'));
async function enrolled(t) {
  const paths = await fixture(t);
  await (await beginDurableEnrollment(paths.directory, identity)).complete(binding);
  return paths;
}

test('no markers is a legacy installation', async t => {
  const { directory } = await fixture(t);
  assert.equal(await assertDurableEnrollmentReady(directory), null);
  assert.equal(await assertDurableEnrollmentReady(directory, { project: 'other' }), null);
});

test('begin writes an exact private pending record that blocks ready and retry', async t => {
  const { directory, pending } = await fixture(t);
  await beginDurableEnrollment(directory, identity);
  const written = await record(pending);
  assert.deepEqual(Object.keys(written), ['schema', 'id', 'project', 'installation', 'planSha256']);
  assert.deepEqual({ ...written, id: 0 }, { schema: 1, id: 0, ...identity });
  assert.match(written.id, /^[0-9a-f-]{36}$/);
  assert.equal((await stat(pending)).mode & 0o7777, 0o600);
  await refuses(assertDurableEnrollmentReady(directory), 'ENROLLMENT_NOT_READY');
  await refuses(beginDurableEnrollment(directory, identity), 'ENROLLMENT_EXISTS');
  assert.deepEqual(await readdir(directory), ['enrollment.pending.json']);
});

test('complete preserves both records and ready returns the sanitized record', async t => {
  const { directory, pending, complete } = await fixture(t);
  const enrollment = await beginDurableEnrollment(directory, identity);
  const before = await readFile(pending);
  const completed = await enrollment.complete(binding);
  assert.deepEqual(await readFile(pending), before);
  assert.deepEqual(await record(complete), { ...JSON.parse(before), inventoryBinding: binding });
  assert.equal((await stat(complete)).mode & 0o7777, 0o600);
  const ready = await assertDurableEnrollmentReady(directory, identity);
  assert.deepEqual(ready, completed); assert.ok(Object.isFrozen(ready));
  assert.deepEqual(await assertDurableEnrollmentReady(directory, { project: identity.project }), completed);
  await refuses(enrollment.complete(binding), 'ENROLLMENT_LATCHED');
  await refuses(beginDurableEnrollment(directory, identity), 'ENROLLMENT_EXISTS');
  assert.deepEqual((await readdir(directory)).sort(), ['enrollment.complete.json', 'enrollment.pending.json']);
});

test('expected identity must match exactly and only name known keys', async t => {
  const { directory } = await enrolled(t);
  for (const key of ['project', 'installation', 'planSha256'])
    await refuses(assertDurableEnrollmentReady(directory, { ...identity, [key]: key === 'project' ? 'other' : 'd'.repeat(64) }), 'ENROLLMENT_NOT_READY');
  await refuses(assertDurableEnrollmentReady(directory, { ...identity, inventoryBinding: binding }), 'ENROLLMENT_EXPECTED');
  await refuses(assertDurableEnrollmentReady(directory, null), 'ENROLLMENT_EXPECTED');
});

test('invalid arguments and directories are refused without creating anything', async t => {
  const { root, directory } = await fixture(t);
  await refuses(beginDurableEnrollment(directory, { ...identity, installation: 'demo' }), 'ENROLLMENT_IDENTITY');
  await refuses(beginDurableEnrollment(directory, { ...identity, planSha256: 'B'.repeat(64) }), 'ENROLLMENT_IDENTITY');
  await refuses(beginDurableEnrollment('relative', identity), 'ENROLLMENT_DIRECTORY');
  const missing = join(root, 'missing');
  await refuses(beginDurableEnrollment(missing, identity), 'ENROLLMENT_DIRECTORY');
  await refuses(assertDurableEnrollmentReady(missing), 'ENROLLMENT_DIRECTORY');
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
  const linked = join(root, 'linked'); await symlink(directory, linked);
  await refuses(beginDurableEnrollment(linked, identity), 'ENROLLMENT_DIRECTORY');
  await chmod(directory, 0o755);
  await refuses(beginDurableEnrollment(directory, identity), 'ENROLLMENT_DIRECTORY');
  await refuses(assertDurableEnrollmentReady(directory), 'ENROLLMENT_DIRECTORY');
  assert.deepEqual(await readdir(directory), []);
  await chmod(directory, 0o700);
  const enrollment = await beginDurableEnrollment(directory, identity);
  await refuses(enrollment.complete('nope'), 'ENROLLMENT_IDENTITY');
  await refuses(enrollment.complete(binding), 'ENROLLMENT_LATCHED');
});

test('any existing marker entry refuses begin', async t => {
  for (const [name, make] of [
    ['enrollment.pending.json', path => writeFile(path, '')],
    ['enrollment.complete.json', path => writeFile(path, '{', { mode: 0o600 })],
    ['enrollment.complete.json', path => symlink('/nonexistent', path)],
    ['enrollment.pending.json', path => mkdir(path)],
  ]) {
    const { directory } = await fixture(t), path = join(directory, name);
    await make(path);
    await refuses(beginDurableEnrollment(directory, identity), 'ENROLLMENT_EXISTS');
    assert.deepEqual(await readdir(directory), [name]);
    await refuses(assertDurableEnrollmentReady(directory), 'ENROLLMENT_NOT_READY');
  }
});

test('orphan, malformed, permission, and foreign-binding records refuse ready', async t => {
  const cases = [
    async ({ pending }) => rm(pending),
    async ({ complete }) => rm(complete),
    async ({ complete }) => chmod(complete, 0o644),
    async ({ pending }) => chmod(pending, 0o400),
    async ({ complete }) => writeFile(complete, (await readFile(complete, 'utf8')).replace(binding, 'C'.repeat(64))),
    async ({ complete }) => writeFile(complete, (await readFile(complete, 'utf8')).replace(/"id":"[^"]+"/, `"id":"${crypto.randomUUID()}"`)),
    async ({ complete }) => writeFile(complete, (await readFile(complete, 'utf8')).replace('fogd-demo', 'fogd-other')),
    async ({ complete }) => writeFile(complete, (await readFile(complete, 'utf8')).trimEnd()),
    async ({ complete }) => writeFile(complete, (await readFile(complete, 'utf8')).replace('{', '{ ')),
    async ({ complete }) => writeFile(complete, (await readFile(complete, 'utf8')).replace('}', ',"secret":"x"}')),
    async ({ pending }) => writeFile(pending, Buffer.concat([await readFile(pending), Buffer.from([0xff])])),
    async ({ complete }) => writeFile(complete, ' '.repeat(2048)),
    async ({ complete }) => { const data = await readFile(complete); await rm(complete); await writeFile(join(complete, '..', 'x'), data, { mode: 0o600 }); await symlink('x', complete); },
    async ({ pending, directory }) => { await rename(pending, join(directory, 'aside')); await symlink(join(directory, 'aside'), pending); },
  ];
  for (const breakIt of cases) {
    const paths = await enrolled(t);
    await breakIt(paths);
    await refuses(assertDurableEnrollmentReady(paths.directory), 'ENROLLMENT_NOT_READY');
  }
});

test('hard-linked records refuse ready', async t => {
  const { directory, complete } = await enrolled(t);
  const { link } = await import('node:fs/promises');
  await link(complete, join(directory, 'copy'));
  await refuses(assertDurableEnrollmentReady(directory), 'ENROLLMENT_NOT_READY');
});

test('racing begins admit one and racing completes admit one', async t => {
  const { directory, pending, complete } = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => beginDurableEnrollment(directory, identity)));
  const winners = results.filter(result => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  for (const { reason } of results.filter(result => result.status === 'rejected')) assert.equal(reason.code, 'ENROLLMENT_EXISTS');
  const enrollment = winners[0].value, before = await readFile(pending);
  const completes = await Promise.allSettled([enrollment.complete(binding), enrollment.complete('d'.repeat(64)), enrollment.complete(binding)]);
  assert.deepEqual(completes.map(result => result.status), ['fulfilled', 'rejected', 'rejected']);
  assert.ok(completes.slice(1).every(result => result.reason.code === 'ENROLLMENT_LATCHED'));
  assert.deepEqual(await readFile(pending), before);
  assert.equal((await record(complete)).inventoryBinding, binding);
  assert.ok(await assertDurableEnrollmentReady(directory, identity));
});

test('pending replacement is preserved and completion latches', async t => {
  for (const replace of [
    async pending => { const data = await readFile(pending); await rm(pending); await writeFile(pending, data, { mode: 0o600 }); },
    async pending => writeFile(pending, (await readFile(pending, 'utf8')).replace('fogd-demo', 'fogd-evil')),
    async pending => chmod(pending, 0o644),
  ]) {
    const { directory, pending } = await fixture(t);
    const enrollment = await beginDurableEnrollment(directory, identity);
    await replace(pending);
    const replaced = await readFile(pending);
    await refuses(enrollment.complete(binding), 'ENROLLMENT_UNCERTAIN');
    await refuses(enrollment.complete(binding), 'ENROLLMENT_LATCHED');
    assert.deepEqual(await readFile(pending), replaced);
    assert.deepEqual(await readdir(directory), ['enrollment.pending.json']);
    await refuses(beginDurableEnrollment(directory, identity), 'ENROLLMENT_EXISTS');
  }
});

test('an externally created complete record is preserved and completion latches', async t => {
  const { directory, complete } = await fixture(t);
  const enrollment = await beginDurableEnrollment(directory, identity);
  await writeFile(complete, 'foreign', { mode: 0o600 });
  await refuses(enrollment.complete(binding), 'ENROLLMENT_UNCERTAIN');
  assert.equal(await readFile(complete, 'utf8'), 'foreign');
  await refuses(assertDurableEnrollmentReady(directory), 'ENROLLMENT_NOT_READY');
});

test('parent replacement is preserved and never recreated', async t => {
  const { root, directory } = await fixture(t);
  const enrollment = await beginDurableEnrollment(directory, identity);
  const moved = join(root, 'moved'); await rename(directory, moved);
  await refuses(enrollment.complete(binding), 'ENROLLMENT_UNCERTAIN');
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
  assert.deepEqual(await readdir(moved), ['enrollment.pending.json']);

  const other = await fixture(t), later = await beginDurableEnrollment(other.directory, identity);
  const aside = join(other.root, 'aside'); await rename(other.directory, aside);
  await mkdir(other.directory, { mode: 0o700 }); await chmod(other.directory, 0o700);
  await refuses(later.complete(binding), 'ENROLLMENT_UNCERTAIN');
  assert.deepEqual(await readdir(other.directory), []);
  assert.deepEqual(await readdir(aside), ['enrollment.pending.json']);
});
