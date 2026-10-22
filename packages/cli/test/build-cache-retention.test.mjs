import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, symlink, link, stat, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { planBuilds, saveBuildPlan, readBuildPlan, applyBuildPlan, keepBuild, localBuilds, resumePrune } from '../src/build-cache/retention.mjs';
import { hash, jsonBytes } from '../src/build-cache/paths.mjs';
import { submittedFixture, origin } from './fixtures/build-cache.mjs';
const exec = promisify(execFile), app = 'cache-test';
const cli = new URL('../bin/fogd.js', import.meta.url);
async function planned(fixture) {
  const plan = await planBuilds(fixture.home, app, fixture.state, origin), file = join(fixture.home, 'plan.json');
  const checksum = await saveBuildPlan(file, plan);
  return { plan, file, checksum };
}
const apply = (fixture, approved, state = fixture.state) => applyBuildPlan(fixture.home, approved.plan, origin, async () => state, approved.checksum);
const present = async path => stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

test('a reviewed superseded copy is removed while legacy output and controller state stay intact', async t => {
  const fixture = await submittedFixture(t), legacy = join(fixture.home, '.fogd/releases', app, 'legacy');
  await mkdir(legacy, { recursive: true }); await writeFile(join(legacy, 'data'), 'preserve');
  const approved = await planned(fixture), before = structuredClone(fixture.state);
  assert.equal(approved.plan.rows[0].decision, 'prune'); assert.equal(approved.plan.legacyEntriesKept, 1);
  assert.equal((await stat(approved.file)).mode & 0o777, 0o600);
  assert.deepEqual(await readBuildPlan(approved.file, approved.checksum), approved.plan);
  const result = await apply(fixture, approved);
  assert.equal(result.results[0].completed, true); assert.equal(result.completedLogicalBytes, approved.plan.reclaimableLogicalBytes);
  assert.equal(await present(fixture.root), false); assert.equal(await readFile(join(legacy, 'data'), 'utf8'), 'preserve');
  assert.deepEqual(fixture.state, before);
  assert.equal((await apply(fixture, approved)).results[0].alreadyAbsent, true);
});
test('a pin added after planning protects exact bytes until explicitly released', async t => {
  const fixture = await submittedFixture(t), approved = await planned(fixture), bytes = await readFile(join(fixture.root, 'artifact/worker/index.js'));
  await keepBuild(fixture.home, app, fixture.release.localBuildId, true);
  assert.equal((await apply(fixture, approved)).results[0].reason, 'operator-kept');
  assert.equal((await planBuilds(fixture.home, app, fixture.state, origin)).rows[0].reason, 'operator-kept');
  assert.deepEqual(await readFile(join(fixture.root, 'artifact/worker/index.js')), bytes);
  await keepBuild(fixture.home, app, fixture.release.localBuildId, false);
  assert.equal((await apply(fixture, approved)).results[0].completed, true);
});
test('execution rechecks live status and recovery references after plan review', async t => {
  const fixture = await submittedFixture(t), approved = await planned(fixture);
  const active = structuredClone(fixture.state); active.deployments[fixture.id].status = 'active';
  assert.equal((await apply(fixture, approved, active)).results[0].reason, 'active-submission');
  const recovery = structuredClone(fixture.state); recovery.apps[app] = { cronRecovery: { status: 'required' } };
  assert.equal((await apply(fixture, approved, recovery)).results[0].reason, 'controller-or-recovery-reference');
  assert.equal(await present(fixture.root), true);
});
for (const kind of ['changed', 'extra', 'symlink', 'hardlink', 'missing']) test(`${kind} data after approval refuses deletion and preserves the tree`, async t => {
  const fixture = await submittedFixture(t), approved = await planned(fixture), worker = join(fixture.root, 'artifact/worker/index.js');
  if (kind === 'changed') await writeFile(worker, 'changed bytes');
  if (kind === 'extra') await writeFile(join(fixture.root, 'extra'), 'unreviewed');
  if (kind === 'symlink') await symlink(worker, join(fixture.root, 'linked'));
  if (kind === 'hardlink') await link(worker, join(fixture.root, 'linked'));
  if (kind === 'missing') await unlink(worker);
  assert.equal((await apply(fixture, approved)).results[0].refused, true);
  assert.equal(await present(fixture.root), true);
});
test('checksum, home binding and forged receipt reject before reading controller state', async t => {
  const fixture = await submittedFixture(t), approved = await planned(fixture); let reads = 0;
  await assert.rejects(readBuildPlan(approved.file, '0'.repeat(64)), /checksum/);
  const read = async () => { reads++; return fixture.state; };
  await assert.rejects(applyBuildPlan(fixture.home, { ...approved.plan, home: '0'.repeat(64) }, origin, read, approved.checksum), /different home/);
  const forged = structuredClone(approved.plan); forged.rows[0].record.submission = '00000000-0000-4000-8000-000000000099';
  await assert.rejects(applyBuildPlan(fixture.home, forged, origin, read, hash(jsonBytes(forged))), /receipt differs/);
  assert.equal(reads, 0); assert.equal(await present(fixture.root), true);
});
test('a replacement directory with identical bytes cannot reuse the approved inode', async t => {
  const fixture = await submittedFixture(t), approved = await planned(fixture), moved = fixture.root + '-saved';
  await rename(fixture.root, moved); await mkdir(fixture.root);
  const { cp } = await import('node:fs/promises'); await cp(moved, fixture.root, { recursive: true });
  assert.equal((await apply(fixture, approved)).results[0].refused, true);
  assert.equal(await present(fixture.root), true); assert.equal(await present(moved), true);
});
test('unknown trash is visible offline and cannot be adopted for deletion', async t => {
  const fixture = await submittedFixture(t), trash = join(fixture.home, '.fogd/build-trash', app, fixture.release.localBuildId);
  await mkdir(trash, { recursive: true }); await writeFile(join(trash, 'unknown'), 'preserve');
  assert.equal((await localBuilds(fixture.home, app)).unfinishedPrunes[0].journalAvailable, false);
  await assert.rejects(resumePrune(fixture.home, app, fixture.release.localBuildId), /No saved prune/);
  assert.equal(await readFile(join(trash, 'unknown'), 'utf8'), 'preserve');
});
async function interrupt(t, fixture, approved) {
  const child = fork(new URL('./fixtures/interrupted-prune.mjs', import.meta.url), [fixture.home, approved.file, approved.checksum, origin, JSON.stringify(fixture.state)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let diagnostics = ''; child.stderr.on('data', chunk => { diagnostics += chunk; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(([code, signal]) => { throw new Error(`Pruner exited before interruption: ${code}/${signal} ${diagnostics}`); }), new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('Pruner interruption timed out')), 15000); timeout.unref(); })]);
  return child;
}
test('SIGKILL releases the real lock and offline CLI resumes saved inventory after loss of the original plan', { timeout: 25000 }, async t => {
  const fixture = await submittedFixture(t), approved = await planned(fixture), child = await interrupt(t, fixture, approved);
  const trash = join(fixture.home, '.fogd/build-trash', app, fixture.release.localBuildId);
  assert.equal(await present(fixture.root), false); assert.equal(await present(trash), true);
  assert.equal(await present(join(trash, approved.plan.rows[0].tree.files[0].path)), false);
  await assert.rejects(keepBuild(fixture.home, app, fixture.release.localBuildId, true), /Cannot lock/);
  const busy = await apply(fixture, approved); assert.equal(busy.results[0].refused, true); assert.match(busy.results[0].reason, /Cannot lock/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); assert.deepEqual(await exited, [null, 'SIGKILL']);
  await unlink(approved.file);
  const env = { ...process.env, FOGD_HOME: fixture.home, FOGD_ENV_FILE: join(fixture.home, 'nonexistent.env'), FOGD_SERVER: 'http://127.0.0.1:1', FOGD_ADMIN_PASSWORD: '' };
  const listed = JSON.parse((await exec(process.execPath, [cli.pathname, 'builds', 'list', app], { env })).stdout);
  assert.equal(listed.unfinishedPrunes[0].journalAvailable, true);
  const result = JSON.parse((await exec(process.execPath, [cli.pathname, 'builds', 'resume', app, fixture.release.localBuildId], { env })).stdout);
  assert.equal(result.completed, true); assert.equal(result.resumed, true); assert.equal(await present(trash), false);
  assert.equal((await resumePrune(fixture.home, app, fixture.release.localBuildId)).alreadyAbsent, true);
});
test('interrupted pruning refuses a new unreviewed trash file and retains it', { timeout: 20000 }, async t => {
  const fixture = await submittedFixture(t), approved = await planned(fixture), child = await interrupt(t, fixture, approved);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const trash = join(fixture.home, '.fogd/build-trash', app, fixture.release.localBuildId);
  await writeFile(join(trash, 'new-data'), 'unreviewed');
  await assert.rejects(resumePrune(fixture.home, app, fixture.release.localBuildId), /unreviewed data/);
  assert.equal(await readFile(join(trash, 'new-data'), 'utf8'), 'unreviewed');
});

test('a fresh verified plan replaces a prepared journal when deletion never began', async t => {
  const fixture = await submittedFixture(t), approved = await planned(fixture);
  const directory = join(fixture.home, '.fogd/build-prunes', app);
  await mkdir(directory, { recursive: true });
  const body = { format: 'fogd-host-cache-prune-v1', home: approved.plan.home, controller: approved.plan.controller, planHash: approved.checksum, row: approved.plan.rows[0] };
  await writeFile(join(directory, `${fixture.release.localBuildId}.json`), jsonBytes({ body, checksum: hash(jsonBytes(body)) }), { mode: 0o600 });
  const saved = fixture.root + '-saved'; await rename(fixture.root, saved);
  const { cp } = await import('node:fs/promises'); await cp(saved, fixture.root, { recursive: true });
  const plan = await planBuilds(fixture.home, app, fixture.state, origin);
  assert.notDeepEqual(plan.rows[0].tree.identity, approved.plan.rows[0].tree.identity);
  const result = await applyBuildPlan(fixture.home, plan, origin, async () => fixture.state, hash(jsonBytes(plan)));
  assert.equal(result.results[0].completed, true); assert.equal(await present(saved), true);
});
for (const change of ['bytes', 'journal', 'home']) test(`resume refuses changed ${change} and preserves remaining files`, { timeout: 20000 }, async t => {
  const fixture = await submittedFixture(t), approved = await planned(fixture), child = await interrupt(t, fixture, approved);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const trash = join(fixture.home, '.fogd/build-trash', app, fixture.release.localBuildId);
  const remaining = approved.plan.rows[0].tree.files.find(file => file.path !== approved.plan.rows[0].tree.files[0].path);
  const file = join(trash, remaining.path), before = await readFile(file);
  if (change === 'bytes') await writeFile(file, 'changed private bytes');
  else {
    const journal = join(fixture.home, '.fogd/build-prunes', app, `${fixture.release.localBuildId}.json`), value = JSON.parse(await readFile(journal, 'utf8'));
    if (change === 'home') { value.body.home = '0'.repeat(64); value.checksum = hash(jsonBytes(value.body)); }
    else value.checksum = '0'.repeat(64);
    await writeFile(journal, jsonBytes(value));
  }
  await assert.rejects(resumePrune(fixture.home, app, fixture.release.localBuildId), /changed|unreviewed/);
  assert.deepEqual(await readFile(file), change === 'bytes' ? Buffer.from('changed private bytes') : before);
});

test('a damaged prepared journal is archived intact before a fresh approved operation', async t => {
  const fixture = await submittedFixture(t), approved = await planned(fixture), directory = join(fixture.home, '.fogd/build-prunes', app);
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from('damaged local journal bytes');
  await writeFile(join(directory, `${fixture.release.localBuildId}.json`), bytes);
  assert.equal((await apply(fixture, approved)).results[0].completed, true);
  const history = await readdir(join(directory, 'history')); assert.equal(history.length, 1);
  assert.deepEqual(await readFile(join(directory, 'history', history[0])), bytes);
});
test('noncanonical receipt bytes remain kept in the generated plan', async t => {
  const fixture = await submittedFixture(t), file = join(fixture.root, 'record.json');
  await writeFile(file, JSON.stringify(JSON.parse(await readFile(file, 'utf8'))));
  const plan = await planBuilds(fixture.home, app, fixture.state, origin);
  assert.equal(plan.rows[0].decision, 'keep'); assert.equal(plan.rows[0].reason, 'changed-build');
});
test('a controller-hash mismatch refuses without reading state', async t => {
  const fixture = await submittedFixture(t), approved = await planned(fixture); let read = false;
  await assert.rejects(applyBuildPlan(fixture.home, approved.plan, 'https://other.example', async () => { read = true; }, approved.checksum), /different home or controller/);
  assert.equal(read, false); assert.equal(await present(fixture.root), true);
});
test('resume refuses dual cache and trash presence without deleting either tree', { timeout: 20000 }, async t => {
  const fixture = await submittedFixture(t), approved = await planned(fixture), child = await interrupt(t, fixture, approved);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await mkdir(fixture.root); await writeFile(join(fixture.root, 'data'), 'new cache bytes');
  await assert.rejects(resumePrune(fixture.home, app, fixture.release.localBuildId), /Both cache and trash/);
  assert.equal(await present(join(fixture.home, '.fogd/build-trash', app, fixture.release.localBuildId)), true);
  assert.equal(await readFile(join(fixture.root, 'data'), 'utf8'), 'new cache bytes');
});
