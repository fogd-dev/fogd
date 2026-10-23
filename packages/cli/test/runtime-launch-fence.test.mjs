import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rename, chmod, symlink, stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLaunchFence, acquireStopFence, LaunchFenceError } from '../src/runtime/launch-fence.mjs';

const exec = promisify(execFile), module = new URL('../src/runtime/launch-fence.mjs', import.meta.url).href;
const identity = { project: 'fogd-demo', installation: 'demo' };
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fogd-fence-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'installation'); await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700);
  return { root, directory, marker: join(directory, 'launch.pending.json') };
}
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const refuses = (promise, code) => assert.rejects(promise, error => error instanceof LaunchFenceError && error.code === code && !error.cause && !error.message.includes('/'));

test('acquire writes a private checking record and releases before effects', async t => {
  const { directory, marker } = await fixture(t);
  const fence = await acquireLaunchFence(directory, identity);
  const record = await read(marker), info = await stat(marker);
  assert.deepEqual(Object.keys(record), ['schema', 'project', 'installation', 'id', 'phase']);
  assert.deepEqual({ ...record, id: undefined }, { schema: 1, ...identity, id: undefined, phase: 'checking' });
  assert.match(record.id, /^[0-9a-f-]{36}$/); assert.equal(info.mode & 0o7777, 0o600);
  await refuses(acquireLaunchFence(directory, identity), 'FENCE_EXISTS');
  await fence.release();
  assert.deepEqual(await readdir(directory), []);
  await refuses(fence.release(), 'FENCE_LATCHED');
  await (await acquireLaunchFence(directory, identity)).release();
});

test('phases advance one checkpoint at a time and release only when complete', async t => {
  const { directory, marker } = await fixture(t);
  const fence = await acquireLaunchFence(directory, identity), { id } = await read(marker);
  for (const phase of ['starting', 'preflight', 'ingress']) {
    await fence.record(phase); assert.deepEqual(await read(marker), { schema: 1, ...identity, id, phase });
  }
  await fence.record('complete'); await fence.release();
  assert.deepEqual(await readdir(directory), []);

  const skipped = await acquireLaunchFence(directory, identity);
  await refuses(skipped.record('preflight'), 'FENCE_PHASE');
  await refuses(skipped.record('starting'), 'FENCE_LATCHED');
  assert.equal((await read(marker)).phase, 'checking');

  await rm(marker);
  const backwards = await acquireLaunchFence(directory, identity);
  await backwards.record('starting');
  await refuses(backwards.record('checking'), 'FENCE_PHASE');
  assert.equal((await read(marker)).phase, 'starting');
});

test('a started attempt cannot release and its marker survives', async t => {
  const { directory, marker } = await fixture(t);
  for (const stop of ['starting', 'preflight', 'ingress']) {
    const fence = await acquireLaunchFence(directory, identity);
    for (const phase of ['starting', 'preflight', 'ingress']) { await fence.record(phase); if (phase === stop) break; }
    await refuses(fence.release(), 'FENCE_ACTIVE');
    await refuses(fence.release(), 'FENCE_LATCHED');
    assert.equal((await read(marker)).phase, stop);
    await refuses(acquireLaunchFence(directory, identity), 'FENCE_EXISTS');
    await rm(marker);
  }
});

test('records survive an interrupted attempt', async t => {
  const { directory, marker } = await fixture(t);
  const script = `const { acquireLaunchFence } = await import(${JSON.stringify(module)});
    const fence = await acquireLaunchFence(process.argv[1], ${JSON.stringify(identity)});
    await fence.record('starting'); await fence.record('preflight'); process.kill(process.pid, 'SIGKILL');`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', script, directory]), { signal: 'SIGKILL' });
  assert.equal((await read(marker)).phase, 'preflight');
  await refuses(acquireLaunchFence(directory, identity), 'FENCE_EXISTS');
});

test('any existing marker refuses, including partial and malformed ones', async t => {
  const { directory, marker } = await fixture(t);
  for (const content of ['', '{"schema":1,"pro', 'not json', JSON.stringify({ schema: 1, ...identity, id: 'x', phase: 'complete' })]) {
    await writeFile(marker, content, { mode: 0o600 });
    await refuses(acquireLaunchFence(directory, identity), 'FENCE_EXISTS');
    assert.equal(await readFile(marker, 'utf8'), content);
  }
  await rm(marker); await mkdir(marker);
  await refuses(acquireLaunchFence(directory, identity), 'FENCE_EXISTS');
  await rm(marker, { recursive: true }); await symlink(join(directory, 'missing'), marker);
  await refuses(acquireLaunchFence(directory, identity), 'FENCE_EXISTS');
  assert.deepEqual(await readdir(directory), ['launch.pending.json']);
});

test('exactly one concurrent acquisition succeeds, across processes too', async t => {
  const { directory } = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 32 }, () => acquireLaunchFence(directory, identity)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'FENCE_EXISTS'));
  await results.find(result => result.status === 'fulfilled').value.release();

  const script = `const { acquireLaunchFence } = await import(${JSON.stringify(module)});
    try { await acquireLaunchFence(process.argv[1], ${JSON.stringify(identity)}); console.log('won'); } catch (error) { console.log(error.code); }`;
  const outputs = await Promise.all(Array.from({ length: 8 }, () => exec(process.execPath, ['--input-type=module', '-e', script, directory])));
  const codes = outputs.map(output => output.stdout.trim()).sort();
  assert.deepEqual(codes, ['FENCE_EXISTS', 'FENCE_EXISTS', 'FENCE_EXISTS', 'FENCE_EXISTS', 'FENCE_EXISTS', 'FENCE_EXISTS', 'FENCE_EXISTS', 'won']);
});

test('an externally replaced marker is never overwritten or unlinked', async t => {
  const { root, directory, marker } = await fixture(t);
  const foreign = JSON.stringify({ schema: 1, ...identity, id: 'foreign', phase: 'checking' });
  const replace = async () => { await writeFile(join(root, 'foreign'), foreign, { mode: 0o600 }); await rename(join(root, 'foreign'), marker); };

  const recorded = await acquireLaunchFence(directory, identity); await replace();
  await refuses(recorded.record('starting'), 'FENCE_UNCERTAIN');
  await refuses(recorded.record('starting'), 'FENCE_LATCHED');
  assert.equal(await readFile(marker, 'utf8'), foreign);

  await rm(marker);
  const released = await acquireLaunchFence(directory, identity); await replace();
  await refuses(released.release(), 'FENCE_UNCERTAIN');
  assert.equal(await readFile(marker, 'utf8'), foreign);

  await rm(marker);
  const edited = await acquireLaunchFence(directory, identity), original = await readFile(marker, 'utf8');
  await writeFile(marker, original.replace('checking', 'starting'));
  await refuses(edited.release(), 'FENCE_UNCERTAIN');
  assert.match(await readFile(marker, 'utf8'), /starting/);
  assert.deepEqual(await readdir(directory), ['launch.pending.json']);
});

test('the directory must be an existing private real directory and stays bound', async t => {
  const { root, directory } = await fixture(t);
  await refuses(acquireLaunchFence('relative/path', identity), 'FENCE_DIRECTORY');
  await refuses(acquireLaunchFence(join(root, 'missing'), identity), 'FENCE_DIRECTORY');
  await assert.rejects(stat(join(root, 'missing')), { code: 'ENOENT' });
  await chmod(directory, 0o750);
  await refuses(acquireLaunchFence(directory, identity), 'FENCE_DIRECTORY');
  await chmod(directory, 0o700);
  await symlink(directory, join(root, 'link'));
  await refuses(acquireLaunchFence(join(root, 'link'), identity), 'FENCE_DIRECTORY');
  await writeFile(join(root, 'file'), '', { mode: 0o700 });
  await refuses(acquireLaunchFence(join(root, 'file'), identity), 'FENCE_DIRECTORY');
  await refuses(acquireLaunchFence(directory, { project: '../x', installation: 'demo' }), 'FENCE_IDENTITY');
  await refuses(acquireLaunchFence(directory, { project: 'fogd-demo' }), 'FENCE_IDENTITY');
  assert.deepEqual(await readdir(directory), []);

  const fence = await acquireLaunchFence(directory, identity);
  await rename(directory, join(root, 'moved'));
  await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700);
  await refuses(fence.record('starting'), 'FENCE_UNCERTAIN');
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await read(join(root, 'moved', 'launch.pending.json'))).phase, 'checking');

  await rm(directory, { recursive: true });
  const removed = await acquireLaunchFence(join(root, 'moved'), identity).catch(error => error.code);
  assert.equal(removed, 'FENCE_EXISTS');
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('launch and stop exclude each other without disturbing the holder', async t => {
  const { directory, marker } = await fixture(t);
  for (const [hold, compete] of [[acquireLaunchFence, acquireStopFence], [acquireStopFence, acquireLaunchFence]]) {
    const held = await hold(directory, identity), before = await readFile(marker);
    await refuses(compete(directory, identity), 'FENCE_EXISTS');
    assert.deepEqual(await readFile(marker), before);
    await held.release();
    assert.deepEqual(await readdir(directory), []);
  }

  const script = `const { acquireLaunchFence, acquireStopFence } = await import(${JSON.stringify(module)});
    const acquire = process.argv[2] === 'stop' ? acquireStopFence : acquireLaunchFence;
    try { await acquire(process.argv[1], ${JSON.stringify(identity)}); console.log('won'); } catch (error) { console.log(error.code); }`;
  const outputs = await Promise.all(Array.from({ length: 8 }, (_, index) => exec(process.execPath, ['--input-type=module', '-e', script, directory, index % 2 ? 'stop' : 'launch'])));
  const codes = outputs.map(output => output.stdout.trim());
  assert.equal(codes.filter(code => code === 'won').length, 1);
  assert.equal(codes.filter(code => code === 'FENCE_EXISTS').length, 7);
});

test('stop marks its operation, advances checking, stopping, complete, and releases only at the ends', async t => {
  const { directory, marker } = await fixture(t);
  const idle = await acquireStopFence(directory, identity), { id } = await read(marker);
  assert.deepEqual(await read(marker), { schema: 1, operation: 'stop', ...identity, id, phase: 'checking' });
  await idle.release();
  assert.deepEqual(await readdir(directory), []);

  const fence = await acquireStopFence(directory, identity), next = (await read(marker)).id;
  for (const phase of ['stopping', 'complete']) {
    await fence.record(phase); assert.deepEqual(await read(marker), { schema: 1, operation: 'stop', ...identity, id: next, phase });
  }
  await fence.release();
  assert.deepEqual(await readdir(directory), []);

  for (const phase of ['starting', 'complete', 'checking']) {
    const wrong = await acquireStopFence(directory, identity);
    await refuses(wrong.record(phase), 'FENCE_PHASE');
    assert.equal((await read(marker)).phase, 'checking');
    await rm(marker);
  }
});

test('a stop that began stopping keeps its marker through release attempts and crashes', async t => {
  const { directory, marker } = await fixture(t);
  const fence = await acquireStopFence(directory, identity);
  await fence.record('stopping');
  await refuses(fence.release(), 'FENCE_ACTIVE');
  await refuses(fence.record('complete'), 'FENCE_LATCHED');
  assert.equal((await read(marker)).phase, 'stopping');
  await refuses(acquireLaunchFence(directory, identity), 'FENCE_EXISTS');
  await refuses(acquireStopFence(directory, identity), 'FENCE_EXISTS');
  await rm(marker);

  const script = `const { acquireStopFence } = await import(${JSON.stringify(module)});
    const fence = await acquireStopFence(process.argv[1], ${JSON.stringify(identity)});
    await fence.record('stopping'); process.kill(process.pid, 'SIGKILL');`;
  await assert.rejects(exec(process.execPath, ['--input-type=module', '-e', script, directory]), { signal: 'SIGKILL' });
  assert.deepEqual({ ...(await read(marker)), id: undefined }, { schema: 1, operation: 'stop', ...identity, id: undefined, phase: 'stopping' });
  await refuses(acquireLaunchFence(directory, identity), 'FENCE_EXISTS');
});

test('a stop never releases or rewrites a marker that replaced its own', async t => {
  const { root, directory, marker } = await fixture(t);
  const foreign = JSON.stringify({ schema: 1, ...identity, id: 'foreign', phase: 'starting' });
  for (const reached of [[], ['stopping'], ['stopping', 'complete']]) {
    const fence = await acquireStopFence(directory, identity);
    for (const phase of reached) await fence.record(phase);
    await writeFile(join(root, 'foreign'), foreign, { mode: 0o600 }); await rename(join(root, 'foreign'), marker);
    await refuses(reached.length === 1 ? fence.record('complete') : fence.release(), 'FENCE_UNCERTAIN');
    assert.equal(await readFile(marker, 'utf8'), foreign);
    await rm(marker);
  }
});
