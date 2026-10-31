import { emptyPreviewDocker as dockerFixture } from './fixtures/preview-host.mjs';
import { previewStorageFixture } from './fixtures/preview-storage.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath, readFile, writeFile, readdir, stat, chmod, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import { createPreviewPlan } from '../src/preview/plan.mjs';
import { initializePreviewHost, reservePreviewHost, inspectPreviewHostReservations } from '../src/preview/host-reservations.mjs';
import { previewPlanFixture } from './fixtures/preview-plan.mjs';

const exec = promisify(execFile), moduleUrl = new URL('../src/preview/host-reservations.mjs', import.meta.url).href;
const engineId = 'engine-fixture', mib = 1024 ** 2;
async function fixture(t, memory) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'fogd-preview-host-'))); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const docker = dockerFixture(memory), directory = join(root, hash(engineId));
  return { root, directory, docker, marker: join(directory, 'launch.pending.json'), holds: join(directory, 'holds'),
    initialize: () => initializePreviewHost({ root, engineId, run: docker.run }),
    reserve: plan => reservePreviewHost({ root, plan, run: docker.run }),
    inspect: () => inspectPreviewHostReservations({ root, engineId }) };
}
const hostRefused = reason => ({ code: 'PREVIEW_HOST_REFUSED', reason });
const plan = (octet = 250, port = 49443) => previewPlanFixture(octet, port).plan;

test('fresh host registry is private and engine-bound; initialization never replaces it', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.initialize(), { initialized: true, engineId, capacityReserved: false, executionAuthorized: false });
  assert.deepEqual(await readdir(f.directory), ['allocations', 'holds', 'host.json']);
  assert.equal((await stat(join(f.directory, 'host.json'))).mode & 0o7777, 0o600);
  assert.equal((await stat(f.holds)).mode & 0o7777, 0o700);
  const original = await readFile(join(f.directory, 'host.json'));
  await assert.rejects(f.initialize(), hostRefused('uncertain'));
  assert.deepEqual(await readFile(join(f.directory, 'host.json')), original);
  assert.deepEqual(await f.inspect(), []);
  assert.ok(f.docker.calls.every(args => args[0] === 'info' || ['ls', 'inspect'].includes(args[1])));
});

test('durable hold reserves the entire envelope, grants no execution and survives fresh process inspection', async t => {
  const f = await fixture(t); await f.initialize(); const p = plan(), result = await f.reserve(p);
  assert.equal(result.capacityReserved, true); assert.equal(result.executionAuthorized, false);
  assert.equal(result.memory.requestedLimitBytes, 4992 * mib);
  const held = await f.inspect(); assert.equal(held.length, 1); assert.deepEqual(held[0].plan, p);
  assert.equal((await stat(join(f.holds, p.project + '.json'))).mode & 0o7777, 0o600);
  const script = `const { inspectPreviewHostReservations } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await inspectPreviewHostReservations({ root: process.argv[1], engineId: process.argv[2] })));`;
  const fresh = await exec(process.execPath, ['--input-type=module', '-e', script, f.root, engineId]);
  assert.deepEqual(JSON.parse(fresh.stdout), held);
  await assert.rejects(f.reserve(plan(249, 49444)), { code: 'PREVIEW_ADMISSION_REFUSED', reason: 'capacity' });
  assert.deepEqual(await readdir(f.directory), ['allocations', 'holds', 'host.json']);
  assert.deepEqual(await f.inspect(), held);
});

test('concurrent local reservations cannot both consume one envelope', async t => {
  const f = await fixture(t); await f.initialize();
  const results = await Promise.allSettled([f.reserve(plan()), f.reserve(plan(249, 49444))]);
  assert.equal(results.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(results.find(value => value.status === 'rejected').reason.reason, 'pending');
  assert.equal((await f.inspect()).length, 1);
});

test('separate processes contend on the same engine fence and only one can reserve', async t => {
  const f = await fixture(t); await f.initialize();
  const args = [plan(), plan(249, 49444), plan(248, 49445)].map(value => JSON.stringify(value));
  const script = `const { reservePreviewHost } = await import(${JSON.stringify(moduleUrl)});
    const host = JSON.parse(process.argv[3]); const run = async a => a[0] === 'info' ? JSON.stringify(host) : '';
    try { console.log(JSON.stringify(await reservePreviewHost({ root: process.argv[1], plan: JSON.parse(process.argv[2]), run }))); }
    catch (error) { console.log(JSON.stringify({ refused: error.reason })); }`;
  const results = await Promise.all(args.map(p => exec(process.execPath, ['--input-type=module', '-e', script, f.root, p, JSON.stringify(f.docker.host)])));
  const outputs = results.map(value => JSON.parse(value.stdout));
  assert.equal(outputs.filter(value => value.capacityReserved).length, 1);
  assert.ok(outputs.filter(value => value.refused).every(value => ['pending', 'capacity'].includes(value.refused)));
  assert.equal((await f.inspect()).length, 1);
});

test('stopped and expired holds remain budgeted without any Docker resources', async t => {
  const f = await fixture(t), later = plan(249, 49444); await f.initialize(); await f.reserve(plan());
  t.mock.method(Date, 'now', () => 8640000000000000);
  await assert.rejects(f.reserve(later), { code: 'PREVIEW_ADMISSION_REFUSED', reason: 'capacity' });
  assert.equal((await f.inspect()).length, 1);
});

test('engine policy refusal releases checking; unregistered resources retain the fence', async t => {
  const f = await fixture(t); await f.initialize(); const p = plan();
  f.docker.host.ID = 'wrong-engine';
  await assert.rejects(f.reserve(p), { code: 'PREVIEW_ADMISSION_REFUSED', reason: 'engine' });
  f.docker.host.ID = engineId;
  f.docker.records.volume.push({ Name: p.volumes.minio.name, Labels: {} });
  await assert.rejects(f.reserve(p), hostRefused('unregistered-resources'));
  assert.equal((await readdir(f.holds)).length, 0);
  assert.equal(JSON.parse(await readFile(f.marker)).phase, 'checking');
});

for (const corrupt of ['partial', 'extra', 'symlink', 'mode', 'changed-plan']) {
  test(`damaged hold refuses without reconstruction or deletion: ${corrupt}`, async t => {
    const f = await fixture(t); await f.initialize(); const p = plan(); await f.reserve(p);
    const file = join(f.holds, p.project + '.json');
    if (corrupt === 'partial') await writeFile(file, '{');
    if (corrupt === 'extra') await writeFile(join(f.holds, 'unknown'), '{}');
    if (corrupt === 'symlink') { await rm(file); await symlink(join(f.directory, 'host.json'), file); }
    if (corrupt === 'mode') await chmod(file, 0o644);
    if (corrupt === 'changed-plan') { const value = JSON.parse(await readFile(file)); value.plan.services.ingress.memoryBytes++; await writeFile(file, jsonBytes(value)); }
    const names = await readdir(f.holds);
    await assert.rejects(f.reserve(plan(249, 49444)), { code: 'PREVIEW_HOST_REFUSED' });
    assert.deepEqual(await readdir(f.holds), names);
    await assert.rejects(f.inspect(), hostRefused('pending'));
    assert.equal(JSON.parse(await readFile(f.marker)).phase, 'checking');
  });
}

for (const partial of [false, true]) test(`interrupted hold write remains fenced and retains its bytes: partial=${partial}`, async t => {
  const f = await fixture(t); await f.initialize(); const p = plan();
  const fenceUrl = new URL('../src/runtime/launch-fence.mjs', import.meta.url).href;
  const recordsUrl = new URL('../src/preview/host-records.mjs', import.meta.url).href;
  const directoryUrl = new URL('../src/runtime/host-directory.mjs', import.meta.url).href;
  const value = { schema: 1, kind: 'fogd-preview-host-hold', id: '1'.repeat(8) + '-1111-1111-1111-' + '1'.repeat(12), createdAt: new Date().toISOString(), planSha256: hash(jsonBytes(p)), plan: p };
  const script = `const { acquireHostOperationFence } = await import(${JSON.stringify(fenceUrl)});
    const { appendHostRecord } = await import(${JSON.stringify(recordsUrl)});
    const { bindHostDirectory } = await import(${JSON.stringify(directoryUrl)});
    const { open } = await import('node:fs/promises');
    const fence = await acquireHostOperationFence(process.argv[1], { project: 'fogd-preview-host', installation: process.argv[2] });
    await fence.record('writing');
    const value = JSON.parse(process.argv[3]);
    if (process.argv[4] === 'true') { const file = await open(process.argv[1] + '/holds/' + value.plan.project + '.json', 'wx', 0o600); await file.writeFile('{'); await file.sync(); await file.close(); }
    else await appendHostRecord(await bindHostDirectory(process.argv[1] + '/holds'), value.plan.project + '.json', value);
    process.exit(0);`;
  await exec(process.execPath, ['--input-type=module', '-e', script, f.directory, hash(engineId), JSON.stringify(value), String(partial)]);
  const before = await readFile(join(f.holds, p.project + '.json'));
  await assert.rejects(f.reserve(plan(249, 49444)), hostRefused('pending'));
  assert.equal(JSON.parse(await readFile(f.marker)).phase, 'writing');
  const names = await readdir(f.holds); assert.equal(names.length, 1);
  assert.deepEqual(await readFile(join(f.holds, names[0])), before);
  if (!partial) assert.deepEqual(JSON.parse(before), value);
});

test('missing, partial, symlinked and foreign engine ledgers never auto-initialize', async t => {
  const f = await fixture(t), p = plan();
  await assert.rejects(f.reserve(p), hostRefused('uncertain')); assert.deepEqual(await readdir(f.root), []);
  await mkdir(f.directory, { mode: 0o700 });
  await assert.rejects(f.reserve(p), hostRefused('layout')); assert.ok((await readdir(f.directory)).includes('launch.pending.json'));
  const other = await fixture(t); await other.initialize();
  const metadata = join(other.directory, 'host.json'), data = JSON.parse(await readFile(metadata)); data.engineId = 'foreign'; await writeFile(metadata, jsonBytes(data));
  await assert.rejects(other.reserve(p), hostRefused('engine'));
  const linked = await fixture(t); await symlink(other.directory, linked.directory);
  await assert.rejects(linked.reserve(p), hostRefused('uncertain'));
});

test('fresh initialization refuses unknown managed resources and retains incomplete state', async t => {
  const f = await fixture(t), p = plan();
  f.docker.records.volume.push({ Name: p.volumes.minio.name, Labels: {} });
  await assert.rejects(f.initialize(), hostRefused('unregistered-resources'));
  assert.equal(JSON.parse(await readFile(f.marker)).phase, 'checking');
  await assert.rejects(f.initialize(), hostRefused('uncertain'));
  assert.equal(f.docker.records.volume[0].Name, p.volumes.minio.name);
});

test('registered active roles count once and malformed unrelated active memory still refuses', async t => {
  const f = await fixture(t, 11 * 1024 ** 3); await f.initialize(); const p = plan(), result = await f.reserve(p);
  const role = 'gateway', service = p.services[role];
  f.docker.records.container.push({ Id: 'a'.repeat(64), Image: p.request.image, Name: '/' + service.name,
    Config: { Labels: { 'fogd.preview.project': p.project, 'fogd.preview.config': result.planSha256, 'fogd.preview.role': role } },
    HostConfig: { Memory: service.memoryBytes, PortBindings: {} }, State: { Running: true, Restarting: false, Paused: false } });
  const second = await f.reserve(plan(249, 49444));
  assert.equal(second.memory.activeLimitBytes, service.memoryBytes); assert.equal(second.memory.heldLimitBytes, 4480 * mib);
  f.docker.records.container[0].HostConfig.Memory = 0;
  await assert.rejects(f.reserve(plan(248, 49445)), { code: 'PREVIEW_ADMISSION_REFUSED', reason: 'unbounded-active-memory' });
  assert.equal((await f.inspect()).length, 2);
});

test('changed source engine cannot initialize the requested engine registry', async t => {
  const f = await fixture(t); f.docker.host.ID = 'other';
  await assert.rejects(f.initialize(), hostRefused('engine'));
  assert.equal(JSON.parse(await readFile(f.marker)).phase, 'checking');
});

test('duplicate reservation identities and mixed engine holds refuse further admission', async t => {
  for (const corrupt of ['duplicate-id', 'engine']) {
    const f = await fixture(t, 11 * 1024 ** 3); await f.initialize(); const a = plan(), b = plan(249, 49444);
    await f.reserve(a); await f.reserve(b);
    const original = (await f.inspect()).find(record => record.plan.project === a.project), file = join(f.holds, b.project + '.json'), changed = JSON.parse(await readFile(file));
    if (corrupt === 'duplicate-id') changed.id = original.id;
    else { changed.plan = createPreviewPlan({ ...b.request, engineId: 'other-engine', storage: previewStorageFixture(b.project, 'other-engine') }); changed.planSha256 = hash(jsonBytes(changed.plan)); }
    await writeFile(file, jsonBytes(changed));
    await assert.rejects(f.reserve(plan(248, 49445)), hostRefused('holds'));
    assert.equal((await readdir(f.holds)).length, 2);
  }
});

test('a different sealed image cannot silently reuse an existing hold', async t => {
  const f = await fixture(t); await f.initialize(); const p = plan(); await f.reserve(p);
  const changed = createPreviewPlan({ ...p.request, image: 'sha256:' + '9'.repeat(64) });
  await assert.rejects(f.reserve(changed), { code: 'PREVIEW_ADMISSION_REFUSED', reason: 'resources-held' });
  assert.deepEqual((await f.inspect())[0].plan, p);
});
