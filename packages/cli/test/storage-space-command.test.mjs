import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spaceFixture } from './fixtures/storage-space-cli.mjs';
const exec = promisify(execFile), spaceRun = args => args[0] === 'run' && args.at(-1).includes('statfsSync');
test('storage observation groups shared filesystems and never bootstraps a profile or mounts named volumes', async t => {
  const f = await spaceFixture(t), before = await readFile(f.file), report = JSON.parse((await f.run()).stdout);
  assert.equal(report.installation, 'original'); assert.equal(report.status, 'observed'); assert.equal(report.storageHealth, 'not-assessed');
  assert.equal(report.volumeUsage, 'not-measured'); assert.equal(report.capacityReservation, 'none'); assert.equal(report.volumes.length, 7);
  assert.equal(report.filesystems.length, 1); assert.equal(report.filesystems[0].availableBytes, '409600');
  assert.ok(report.volumes.every(row => row.filesystem === 'filesystem-1' && row.state === 'sampled'));
  const calls = await f.calls(), sample = calls.find(spaceRun); assert.ok(sample);
  const mounts = sample.filter(value => value.startsWith('type=bind,')); assert.equal(mounts.length, 7); assert.ok(mounts.every(value => value.endsWith(',readonly')));
  assert.ok(mounts.includes('type=bind,src=/var/lib/docker/volumes/original_bucket/_data,dst=/space/v0,readonly'));
  assert.ok(calls.every(args => !args.some(value => value.startsWith('type=volume,'))));
  assert.ok(calls.every(args => ['info', 'volume', 'image', 'run', 'ps'].includes(args[0])));
  assert.ok(calls.filter(args => args[0] === 'volume').every(args => ['ls', 'inspect'].includes(args[1])));
  assert.ok(calls.filter(args => args[0] === 'run').every(args => args.includes('--read-only') && args[args.indexOf('--network') + 1] === 'none'));
  assert.ok(calls.filter(args => args[0] === 'run').every(args => args[args.indexOf('--pull') + 1] === 'never'));
  assert.equal(sample[sample.indexOf('--pull') + 1], 'never'); assert.equal(sample.includes('--cap-add'), false);
  assert.equal(calls.flat().join('\n').includes('private-host-'), false);
  assert.deepEqual(await readFile(f.file), before); await assert.rejects(access(f.env.FOGD_ENV_FILE), { code: 'ENOENT' });
});
test('an unfinished restoration is inspectable but its startup fence remains', async t => {
  const f = await spaceFixture(t), marker = join(f.directory, 'restore.pending.json'); await writeFile(marker, '{"pending":true}');
  assert.equal(JSON.parse((await f.run()).stdout).status, 'observed'); assert.equal(await readFile(marker, 'utf8'), '{"pending":true}');
  await assert.rejects(exec(process.execPath, [new URL('../bin/fogd.js', import.meta.url).pathname, 'up', '--installation', 'original'], { env: f.env }), /Restoration is incomplete/);
});
test('missing storage is reported without mounting or recreating its path', async t => {
  const f = await spaceFixture(t), report = JSON.parse((await f.run(undefined, { FOGD_SPACE_MISSING: 'bucket' })).stdout);
  assert.equal(report.status, 'incomplete'); assert.deepEqual(report.volumes.find(v => v.role === 'bucket'), { role: 'bucket', name: 'original_bucket', state: 'missing', filesystem: null });
  assert.ok((await f.calls()).find(spaceRun).every(value => !value.includes('/original_bucket/')));
});
test('all missing volumes need no image helper and report no invented capacity', async t => {
  const f = await spaceFixture(t), report = JSON.parse((await f.run(undefined, { FOGD_SPACE_MISSING: 'all' })).stdout);
  assert.equal(report.status, 'incomplete'); assert.deepEqual(report.filesystems, []); assert.equal(report.volumes.length, 7);
  assert.equal((await f.calls()).some(args => args[0] === 'run'), false);
});
for (const extra of [{ FOGD_SPACE_FOREIGN: 'bucket' }, { FOGD_SPACE_DRIVER: 'external' }, { FOGD_SPACE_OPTIONS: '1' }, { FOGD_SPACE_BAD_PATH: '1' }]) test(`foreign or unverified storage refuses before helpers: ${JSON.stringify(extra)}`, async t => {
  const f = await spaceFixture(t); await assert.rejects(f.run(undefined, extra), /not owned local project storage|Cannot verify local volume backing path/);
  assert.equal((await f.calls()).some(args => args[0] === 'run'), false);
});
for (const extra of [{ FOGD_SPACE_DISAPPEARS: 'bucket' }, { FOGD_SPACE_CHANGED_ENGINE: '1' }]) test(`changed storage inventory cannot produce a successful report: ${JSON.stringify(extra)}`, async t => {
  const f = await spaceFixture(t); await assert.rejects(f.run(undefined, extra), error => /inventory changed/.test(error.stderr) && !error.stdout);
});
test('a failed helper is cleaned by its nonce identity without exposing its output', async t => {
  const f = await spaceFixture(t);
  await assert.rejects(f.run(undefined, { FOGD_SPACE_HELPER_FAIL: '1', FOGD_SPACE_LEFTOVER: '1' }), error => /failed \(17\)/.test(error.stderr) && !error.stderr.includes('private-helper') && !error.stdout);
  const calls = await f.calls(); assert.deepEqual(calls.filter(args => args[0] === 'rm'), [['rm', '-f', 'a'.repeat(64)]]);
  const selects = calls.filter(args => args[0] === 'ps'); assert.equal(selects.length, 2); assert.deepEqual(selects[0], selects[1]);
  assert.ok(selects[0].some(value => value.startsWith('label=fogd.observer.id='))); assert.ok(selects[0].some(value => value.startsWith('name=^/fogd-space-')));
});
test('malformed helper output is refused after confirmed cleanup', async t => {
  const f = await spaceFixture(t); await assert.rejects(f.run(undefined, { FOGD_SPACE_BAD_OUTPUT: '1', FOGD_SPACE_LEFTOVER: '1' }), error => /Cannot decode filesystem observation/.test(error.stderr) && !error.stderr.includes('private-invalid') && !error.stdout);
  assert.equal((await f.calls()).filter(args => args[0] === 'rm').length, 1);
});
test('unconfirmed helper cleanup is fatal rather than a normal space report', async t => {
  const f = await spaceFixture(t); await assert.rejects(f.run(undefined, { FOGD_SPACE_CLEANUP_FAIL: '1' }), /cleanup is unconfirmed/);
});
for (const args of [[], ['space'], ['space', '--installation', ''], ['space', '--installation', '../escape'], ['space', '--installation', 'absent'], ['prune', '--installation', 'original'], ['space', '--installation', 'original', '--force']]) test(`bad storage selection refuses before Docker: ${JSON.stringify(args)}`, async t => {
  const f = await spaceFixture(t); await assert.rejects(f.run(args)); assert.deepEqual(await f.calls(), []);
});

for (const mode of ['image mismatch', 'candidate family', 'missing policy declaration']) test(`unsupported enrollment refuses storage observation before Docker: ${mode}`, async t => {
  const f = await spaceFixture(t), config = JSON.parse(await readFile(f.file, 'utf8'));
  if (mode === 'image mismatch') config.services.controller.image = 'sha256:' + 'f'.repeat(64);
  if (mode === 'missing policy declaration') {
    delete config.volumes['runtime-policy'];
    config.services.controller.volumes = config.services.controller.volumes.filter(mount => mount.source !== 'runtime-policy');
  }
  if (mode === 'candidate family') {
    const file = join(f.root, 'cli/src/runtime/catalog.json'), entries = JSON.parse(await readFile(file, 'utf8'));
    entries[0].admission = 'candidate'; await writeFile(file, JSON.stringify(entries));
  }
  await writeFile(f.file, JSON.stringify(config));
  await assert.rejects(f.run(), /enrolled catalog-pinned configuration/); assert.deepEqual(await f.calls(), []);
});

test('durable storage observation validates its independent policy and samples the extra authority volumes', async t => {
  const f = await spaceFixture(t, { durable: true }), before = await readFile(f.file);
  const report = JSON.parse((await f.run()).stdout);
  assert.equal(report.status, 'observed');
  for (const role of ['route-authority', 'gateway-policy', 'route-enrollment']) assert.ok(report.volumes.some(volume => volume.role === role && volume.state === 'sampled'));
  const calls = await f.calls(); assert.ok(calls.some(args => args[0] === 'run' && args.at(-1).includes('readRuntimePolicy')));
  assert.deepEqual(await readFile(f.file), before);
});

test('durable storage observation refuses changed authority mounts before sampling data', async t => {
  const f = await spaceFixture(t, { durable: true }), config = JSON.parse(await readFile(f.file));
  config.services.workerd.volumes.find(mount => mount.source === 'route-authority').read_only = false;
  await writeFile(f.file, JSON.stringify(config));
  await assert.rejects(f.run(), /Durable runtime|Storage configuration differs/);
  assert.ok(!(await f.calls()).some(args => args[0] === 'run' && args.at(-1).includes('statfsSync')));
});
