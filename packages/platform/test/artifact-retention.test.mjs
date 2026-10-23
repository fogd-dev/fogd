import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink, link, readdir, lstat } from 'node:fs/promises';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { artifactDigest, stageArtifact } from '@fogd/runtime/artifact';
import { manifest } from '@fogd/runtime/manifest';
import { planArtifactRetention } from '../src/artifact-retention.mjs';
import { artifactInventory } from '../src/artifact-inventory.mjs';
import { ArtifactQuota } from '../src/quota.mjs';
import { Controller } from '../src/controller.mjs';

const REFUSED = /^Cannot inventory retained artifacts; remove links, special files or unreadable entries from the controller artifacts directory$/;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binary = Buffer.from([0, 255, 1, 254, 10, 13, 0]);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'artifacts'); await mkdir(dir);
  const artifact = async (name, files = { 'worker/index.js': 'export default {}', 'bin.wasm': binary }) => {
    for (const [path, data] of Object.entries(files)) { await mkdir(join(dir, name, path, '..'), { recursive: true }); await writeFile(join(dir, name, path), data); }
    return artifactDigest(join(dir, name));
  };
  return { root, dir, artifact };
}
const record = (key, status, digest, extra = {}) => ({ id: key, app: 'hello', digest, status, submittedAt: '2026-01-01T00:00:00.000Z', ...extra });
const byId = rows => Object.fromEntries(rows.map(row => [row.id, row]));
const fileBytes = files => Object.values(files).reduce((sum, data) => sum + Buffer.byteLength(data), 0);

test('only well-formed terminal artifacts matching their digest are candidates; totals match quota accounting', async t => {
  const { dir, artifact } = await fixture(t);
  const files = { 'worker/index.js': 'export default {fetch(){}}', 'bin.wasm': binary, 'fogd-release.json': '{"app":"hello"}' };
  const deployments = {};
  for (const [n, status] of [[1, 'rejected'], [2, 'superseded'], [3, 'active'], [4, 'pending'], [5, 'failed'], [6, 'activating'], [7, 'retired'], [8, 'archived']]) {
    deployments[id(n)] = record(id(n), status, await artifact(id(n), files));
  }
  const plan = await planArtifactRetention({ apps: {}, deployments }, dir);
  const quota = new ArtifactQuota(1e9); await quota.init(dir, deployments);
  assert.equal(plan.retainedArtifactBytes, quota.used);
  assert.equal(plan.retainedArtifactBytes, 8 * fileBytes(files));
  assert.equal(plan.reclaimableArtifactBytes, 2 * fileBytes(files));
  assert.equal(plan.protectedArtifactBytes, 6 * fileBytes(files));
  assert.deepEqual(plan.candidates, [
    { id: id(1), app: 'hello', digest: deployments[id(1)].digest, status: 'rejected', bytes: fileBytes(files) },
    { id: id(2), app: 'hello', digest: deployments[id(2)].digest, status: 'superseded', bytes: fileBytes(files) },
  ]);
  assert.deepEqual(plan.protected.map(row => [row.id, row.status, row.reasons]), [
    [id(3), 'active', ['active']], [id(4), 'pending', ['unfinished']], [id(5), 'failed', ['unfinished']],
    [id(6), 'activating', ['unfinished']], [id(7), 'retired', ['retired']], [id(8), 'unknown', ['unknown-status']],
  ]);
  assert.deepEqual(plan.missing, []);
  assert.equal(plan.schema, 1); assert.equal(plan.policy, 'fogd-terminal-artifact-retention-v1'); assert.match(plan.plan, /^[0-9a-f]{64}$/);
  const inventory = await artifactInventory(dir);
  assert.equal(inventory[0].digest, deployments[id(1)].digest);
  assert.deepEqual(inventory[0].files.map(file => file.path), ['bin.wasm', 'fogd-release.json', 'worker/index.js']);
});

test('controller metadata references, including object keys and unknown fields, protect terminal artifacts', async t => {
  const { dir, artifact } = await fixture(t);
  const deployments = {};
  for (let n = 1; n <= 15; n++) deployments[id(n)] = record(id(n), 'superseded', await artifact(id(n)));
  const apps = {
    hello: { slot: 'one', active: id(1), uncertain: id(2), claim: { deployment: id(3) }, delivery: { deployment: id(4) }, dispatch: { attempts: [{ deployment: id(5) }] },
      queueSnapshot: { deployment: id(6) }, cronSnapshot: { source: id(7) }, queueRecovery: { prepared: id(8) }, retirement: { deployment: id(9) } },
  };
  const state = { apps, deployments, routeAuthority: { holds: { [id(10)]: { route: 'paused' } }, pending: [{ publication: { deployment: id(11) } }] }, recovery: { [id(12)]: true }, futureField: [[{ nested: id(13) }]] };
  const plan = await planArtifactRetention(state, dir);
  assert.deepEqual(plan.candidates.map(row => row.id), [id(14), id(15)]);
  for (let n = 1; n <= 13; n++) assert.deepEqual(byId(plan.protected)[id(n)].reasons, ['controller-reference'], `deployment ${n}`);
});

test('inventory hashes binary content across read boundaries', async t => {
  const { dir, artifact } = await fixture(t);
  const content = Buffer.alloc(64 * 1024 + 7, 255);
  content[0] = 0; content[65535] = 128; content[65536] = 129; content[content.length - 1] = 1;
  const digest = await artifact(id(1), { 'worker/blob.wasm': content });
  const rows = await artifactInventory(dir);
  assert.equal(rows[0].digest, digest);
  assert.deepEqual(rows[0].files, [{ path: 'worker/blob.wasm', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') }]);
});

test('empty directory changes invalidate the plan without changing artifact bytes or digest', async t => {
  const { dir, artifact } = await fixture(t);
  const state = { apps: {}, deployments: { [id(1)]: record(id(1), 'rejected', await artifact(id(1))) } };
  const before = await planArtifactRetention(state, dir);
  await mkdir(join(dir, id(1), 'worker/empty/nested'), { recursive: true });
  const after = await planArtifactRetention(state, dir);
  assert.notEqual(after.plan, before.plan);
  assert.deepEqual(after.candidates, before.candidates);
  assert.equal(after.retainedArtifactBytes, before.retainedArtifactBytes);
});

test('protected records retain transitive and cyclic references while unrelated terminal chains stay candidates', async t => {
  const { dir, artifact } = await fixture(t);
  const d = {};
  for (let n = 1; n <= 7; n++) d[id(n)] = record(id(n), 'superseded', await artifact(id(n)));
  d[id(1)].status = 'active'; d[id(1)].replaces = id(2);
  d[id(2)].previous = id(3); d[id(3)].previous = id(2);
  d[id(4)].replaces = { [id(5)]: true }; // terminal and unreferenced: not a root
  d[id(6)].status = 'failed'; d[id(6)].replaces = id(1);
  const plan = await planArtifactRetention({ apps: {}, deployments: d }, dir);
  const kept = byId(plan.protected);
  assert.deepEqual(kept[id(1)].reasons, ['active', 'deployment-reference']);
  assert.deepEqual(kept[id(2)].reasons, ['deployment-reference']);
  assert.deepEqual(kept[id(3)].reasons, ['deployment-reference']);
  assert.deepEqual(kept[id(6)].reasons, ['unfinished']);
  assert.deepEqual(plan.candidates.map(row => row.id), [id(4), id(5), id(7)]);
});

test('malformed records, mismatched bytes, orphans and missing artifacts are retained or reported without reclaim bytes', async t => {
  const { dir, artifact } = await fixture(t);
  const digest = await artifact(id(1));
  const d = {
    [id(1)]: record(id(1), 'rejected', digest, { replaces: id(9) }),
    [id(2)]: record(id(3), 'rejected', await artifact(id(2))),
    [id(4)]: record(id(4), 'rejected', (await artifact(id(4))).toUpperCase()),
    [id(5)]: record(id(5), 'rejected', await artifact(id(5)), { app: 'Bad_App' }),
    'not-a-uuid': record('not-a-uuid', 'rejected', await artifact('not-a-uuid')),
    [id(13)]: 'not an object',
    [id(7)]: record(id(7), 'rejected', await artifact(id(7))),
    [id(8)]: record(id(8), 'constructor', await artifact(id(8))),
    [id(9)]: record(id(9), 'superseded', await artifact(id(9))),
    [id(10)]: record(id(10), 'active', digest),
    [id(11)]: record(id(11), 'rejected', digest),
    [id(12)]: record(id(12), 'superseded', digest),
  };
  d[id(6)] = { app: 'hello', status: 'superseded', replaces: id(9) }; await artifact(id(6));
  await writeFile(join(dir, id(7), 'worker/index.js'), 'tampered');
  await writeFile(join(dir, id(12)), 'root file named like a deployment');
  await artifact('orphan-dir'); await artifact('referenced-orphan');
  await writeFile(join(dir, 'stray.txt'), binary);
  const plan = await planArtifactRetention({ apps: { hello: { note: 'referenced-orphan' } }, deployments: d }, dir);
  const kept = byId(plan.protected);
  assert.deepEqual(plan.candidates.map(row => row.id), [id(1)]);
  assert.deepEqual(kept[id(2)].reasons, ['invalid-deployment']);
  assert.deepEqual([kept[id(4)].digest, kept[id(4)].reasons], [null, ['digest-mismatch', 'invalid-deployment']]);
  assert.deepEqual([kept[id(5)].app, kept[id(5)].reasons], [null, ['invalid-deployment']]);
  assert.deepEqual(kept['not-a-uuid'].reasons, ['invalid-deployment']);
  assert.deepEqual(kept[id(6)].reasons, ['digest-mismatch', 'invalid-deployment']);
  assert.deepEqual(kept[id(7)].reasons, ['digest-mismatch']);
  assert.deepEqual([kept[id(8)].status, kept[id(8)].reasons], ['unknown', ['unknown-status']]);
  assert.deepEqual(kept[id(9)].reasons, ['deployment-reference']);
  assert.deepEqual([kept[id(12)].status, kept[id(12)].reasons], ['superseded', ['digest-mismatch']]);
  assert.deepEqual(kept['orphan-dir'], { id: 'orphan-dir', app: null, digest: null, status: null, bytes: plan.candidates[0].bytes, reasons: ['unreferenced'] });
  assert.deepEqual(kept['referenced-orphan'].reasons, ['controller-reference', 'unreferenced']);
  assert.deepEqual(kept['stray.txt'], { id: 'stray.txt', app: null, digest: null, status: null, bytes: binary.length, reasons: ['unreferenced'] });
  assert.deepEqual(plan.missing, [
    { id: id(10), app: 'hello', digest, status: 'active', reasons: ['active'] },
    { id: id(11), app: 'hello', digest, status: 'rejected', reasons: [] },
    { id: id(13), app: null, digest: null, status: 'unknown', reasons: ['unknown-status', 'invalid-deployment'] },
  ]);
  assert.equal(plan.protectedArtifactBytes, plan.protected.reduce((sum, row) => sum + row.bytes, 0));
});

test('unusable metadata shapes and artifact roots are refused with fixed errors', async t => {
  const { root, dir } = await fixture(t);
  for (const state of [null, [], 'state', { apps: {} }, { apps: {}, deployments: [] }, { deployments: {} }, { apps: [], deployments: {} }]) {
    await assert.rejects(planArtifactRetention(state, dir), /^Error: Controller metadata is not usable for artifact retention planning; restore a consistent state.json$/);
  }
  await writeFile(join(root, 'plain-file'), 'x'); await symlink(dir, join(root, 'linked'));
  for (const path of [join(root, 'absent'), join(root, 'plain-file'), join(root, 'linked')]) {
    await assert.rejects(planArtifactRetention({ apps: {}, deployments: {} }, path), { message: REFUSED });
  }
});

test('links, hard links and special files are refused without following, reading or echoing them', async t => {
  const { root, dir, artifact } = await fixture(t);
  await writeFile(join(root, 'outside-secret'), 'SECRET-OUTSIDE');
  const cases = [
    async () => symlink(join(root, 'outside-secret'), join(dir, 'link-at-root')),
    async () => { await artifact(id(1)); await symlink(join(root, 'outside-secret'), join(dir, id(1), 'worker/leak.js')); },
    async () => { await artifact(id(1)); await symlink(root, join(dir, id(1), 'nested-dir')); },
    async () => { await artifact(id(1)); await link(join(root, 'outside-secret'), join(dir, id(1), 'hard.js')); },
    async () => { await artifact(id(1)); await link(join(dir, id(1), 'bin.wasm'), join(dir, id(1), 'twin.wasm')); },
  ];
  for (const create of cases) {
    await rm(dir, { recursive: true, force: true }); await mkdir(dir); await create();
    const error = await planArtifactRetention({ apps: {}, deployments: {} }, dir).then(() => null, error => error);
    assert.match(error?.message, REFUSED); assert.equal(error.code, 'ARTIFACT_INVENTORY_REFUSED');
    assert.doesNotMatch(`${error.message}${error.stack}${JSON.stringify(error)}`, /SECRET|outside|fogd-retention|0000/);
    assert.equal(error.cause, undefined);
  }
});

test('a FIFO in an artifact is refused without blocking', async t => {
  const { dir, artifact } = await fixture(t);
  await artifact(id(1)); execFileSync('mkfifo', [join(dir, id(1), 'worker/pipe')]);
  const script = `import { planArtifactRetention } from ${JSON.stringify(new URL('../src/artifact-retention.mjs', import.meta.url).href)};
    await planArtifactRetention({ apps: {}, deployments: {} }, ${JSON.stringify(dir)}).then(() => console.log('planned'), error => console.log(error.code));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.signal, null, 'planner blocked on FIFO');
  assert.equal(child.stdout.trim(), 'ARTIFACT_INVENTORY_REFUSED');
});

test('plan is stable for unchanged inputs and changes with bytes, excluded metadata, references, status and shape', async t => {
  const { dir, artifact } = await fixture(t);
  const deployments = { [id(1)]: record(id(1), 'rejected', await artifact(id(1), { 'worker/index.js': 'a', 'fogd-release.json': '{}' })) };
  const state = { apps: {}, deployments };
  const plan = async () => (await planArtifactRetention(state, dir)).plan;
  const seen = new Set([await plan()]);
  assert.equal(await plan(), [...seen][0]);
  const changed = async (label, change) => {
    await change(); const next = await plan();
    assert.ok(!seen.has(next), label); seen.add(next);
  };
  await changed('excluded release metadata', () => writeFile(join(dir, id(1), 'fogd-release.json'), '{"changed":true}'));
  assert.equal((await planArtifactRetention(state, dir)).candidates.length, 1);
  await changed('new empty file', () => writeFile(join(dir, id(1), 'worker/empty'), ''));
  deployments[id(1)].digest = await artifactDigest(join(dir, id(1)));
  await changed('status', async () => { deployments[id(1)].status = 'superseded'; });
  await changed('controller reference', async () => { state.apps.hello = { active: id(1) }; });
  await changed('stray root file', () => writeFile(join(dir, 'stray'), 'x'));
  await changed('content byte', () => writeFile(join(dir, id(1), 'worker/index.js'), 'b'));
});

test('payload exposes only fixed fields and never mutates metadata or files', async t => {
  const { dir, artifact } = await fixture(t);
  const sensitive = { error: 'SENSITIVE-ERROR', version: 'SENSITIVE-VERSION', secretRevision: 'SENSITIVE-REVISION', resources: { d1: [{ database_id: 'SENSITIVE-DB' }] }, requiredSecrets: ['SENSITIVE-SECRET'], submitter: 'SENSITIVE-SUBMITTER' };
  const deployments = {
    [id(1)]: record(id(1), 'failed', await artifact(id(1), { 'worker/index.js': 'SENSITIVE-CONTENT' }), sensitive),
    [id(2)]: record(id(2), 'rejected', await artifact(id(2)), sensitive),
    [id(3)]: record(id(3), 'active', '1'.repeat(64), sensitive),
  };
  const state = { apps: { hello: { slot: 'SENSITIVE-SLOT', privateConfiguration: true } }, deployments };
  const before = structuredClone(state);
  const snapshot = async () => Promise.all((await readdir(dir, { recursive: true })).sort().map(async path => {
    const info = await lstat(join(dir, path));
    return [path, info.mtimeMs, info.isFile() ? (await readFile(join(dir, path))).toString('hex') : null];
  }));
  const files = await snapshot();
  const plan = await planArtifactRetention(state, dir);
  assert.deepEqual(state, before); assert.deepEqual(await snapshot(), files);
  assert.doesNotMatch(JSON.stringify(plan), /SENSITIVE|worker|bin\.wasm|sha256|files|kind/);
  assert.deepEqual(Object.keys(plan), ['schema', 'policy', 'plan', 'retainedArtifactBytes', 'reclaimableArtifactBytes', 'protectedArtifactBytes', 'candidates', 'protected', 'missing']);
  assert.deepEqual(Object.keys(plan.candidates[0]), ['id', 'app', 'digest', 'status', 'bytes']);
  assert.deepEqual(Object.keys(plan.protected[0]), ['id', 'app', 'digest', 'status', 'bytes', 'reasons']);
  assert.deepEqual(Object.keys(plan.missing[0]), ['id', 'app', 'digest', 'status', 'reasons']);
});

test('controller-created artifacts: rejected and superseded releases become candidates, the active release stays', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fogd-retention-controller-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owners = {}, applied = {};
  const backend = {
    owner: async slot => owners[slot.id] || null,
    hasDeployment: async () => false,
    assertUnclaimed: async () => {},
    claim: async (slot, app) => { owners[slot.id] = { app }; },
    publish: async () => 'version', ready: async () => {}, applicationReady: async () => {},
    migrate: async (slot, _dir, resources) => { for (const db of resources.d1) (applied[slot.id] ||= []).push({ database: db.database_id, name: '0001_init.sql' }); },
    applied: async slot => applied[slot.id] || [],
  };
  const controller = new Controller({ dir: join(root, 'state'), slots: [{ id: 'one', prefix: 'one', nodes: ['a', 'b'] }], backend, reportStorageFailure: () => {} });
  await controller.init();
  let sequence = 0;
  const upload = async () => {
    const project = join(root, `project-${sequence++}`); await mkdir(join(project, 'dist/ssr'), { recursive: true }); await mkdir(join(project, 'db/migrations'), { recursive: true });
    await writeFile(join(project, 'dist/ssr/index.js'), `export default {fetch(){return new Response("${sequence}")}}`);
    await writeFile(join(project, 'dist/ssr/wrangler.json'), JSON.stringify({ main: 'index.js', d1_databases: [{ binding: 'DB' }] }));
    await writeFile(join(project, 'db/migrations/0001_init.sql'), 'CREATE TABLE t (id TEXT);');
    const outputDir = join(project, 'artifact');
    return controller.submit(await manifest(outputDir, await stageArtifact({ projectDir: project, outputDir, app: 'hello' })), 'team-token');
  };
  const rejected = await upload(); await controller.mutate(rejected.id, rejected.digest, 'reject');
  const first = await upload(); await controller.mutate(first.id, first.digest, 'approve');
  const second = await upload(); await controller.mutate(second.id, second.digest, 'approve');
  const pending = await upload();
  assert.deepEqual([rejected.status, first.status, second.status, pending.status], ['rejected', 'superseded', 'active', 'pending']);
  const plan = await planArtifactRetention(controller.state, controller.artifact(''));
  assert.deepEqual(plan.candidates.map(row => row.id).sort(), [rejected.id, first.id].sort());
  assert.deepEqual(byId(plan.protected)[second.id].reasons, ['active', 'controller-reference']);
  assert.deepEqual(byId(plan.protected)[pending.id].reasons, ['unfinished']);
  assert.equal(plan.retainedArtifactBytes, controller.quota.used);
});
