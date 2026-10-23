import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, lstat, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { stageArtifact } from '@fogd/runtime/artifact';
import { manifest } from '@fogd/runtime/manifest';
import { Controller } from '../src/controller.mjs';
import { planArtifactRetention } from '../src/artifact-retention.mjs';
import { artifactInventory } from '../src/artifact-inventory.mjs';
import { artifactPruneStatus, assertArtifactSnapshotReady, validateArtifactPruning } from '../src/artifact-prune-state.mjs';
import { readJson, saveJson } from '../src/store.mjs';

const slots = [{ id: 'one', prefix: 'one', nodes: ['a', 'b'] }];
const PENDING = { code: 'ARTIFACT_PRUNE_PENDING' };

// Real controller, real artifact writer and real filesystem; only the backend is a fake.
async function world(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-prune-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'state'), owners = {}, applied = {}, calls = [], writes = [];
  let fault = null, sequence = 0;
  const fake = {
    owner: async slot => owners[slot.id] || null, hasDeployment: async () => false, assertUnclaimed: async () => {},
    claim: async (slot, app) => { owners[slot.id] = { app }; },
    publish: async () => 'version', ready: async () => {}, applicationReady: async () => {},
    migrate: async (slot, _dir, resources) => { for (const db of resources.d1) (applied[slot.id] ||= []).push({ database: db.database_id, name: '0001_init.sql' }); },
    applied: async slot => applied[slot.id] || [],
  };
  const backend = new Proxy(fake, { get: (target, key) => typeof target[key] === 'function' ? (...args) => { calls.push(key); return target[key](...args); } : undefined });
  const persist = async (path, value) => {
    if (path.endsWith('state.json')) writes.push(structuredClone(value));
    const fail = fault?.(value);
    if (fail === 'before') throw Error('disk unavailable');
    await saveJson(path, value);
    if (fail === 'after') throw Error('lost write response');
  };
  const create = (options = {}) => new Controller({ dir, slots, backend, persist, reportStorageFailure: () => {}, ...options });
  const upload = async c => {
    const project = join(root, `project-${sequence++}`);
    await mkdir(join(project, 'dist/ssr'), { recursive: true }); await mkdir(join(project, 'db/migrations'), { recursive: true });
    await writeFile(join(project, 'dist/ssr/index.js'), `export default {fetch(){return new Response("${sequence}")}}`);
    await writeFile(join(project, 'dist/ssr/wrangler.json'), JSON.stringify({ main: 'index.js', d1_databases: [{ binding: 'DB' }] }));
    await writeFile(join(project, 'db/migrations/0001_init.sql'), 'CREATE TABLE t (id TEXT);');
    const outputDir = join(project, 'artifact');
    return c.submit(await manifest(outputDir, await stageArtifact({ projectDir: project, outputDir, app: 'hello' })), 'team-token');
  };
  const c = create(); await c.init();
  const rejected = await upload(c); await c.mutate(rejected.id, rejected.digest, 'reject');
  const superseded = await upload(c); await c.mutate(superseded.id, superseded.digest, 'approve');
  const active = await upload(c); await c.mutate(active.id, active.digest, 'approve');
  assert.deepEqual([rejected.status, superseded.status, active.status], ['rejected', 'superseded', 'active']);
  calls.length = 0; writes.length = 0;
  const artifacts = join(dir, 'artifacts');
  return { root, dir, artifacts, c, create, upload, calls, writes, rejected, superseded, active,
    fail: callback => { fault = callback; },
    plan: (controller = c) => planArtifactRetention(controller.state, artifacts),
    reload: async options => { fault = null; const next = create(options); await next.init(); return next; } };
}

async function tree(dir) {
  const entries = (await readdir(dir, { recursive: true })).sort();
  return Promise.all(entries.map(async path => [path, (await lstat(join(dir, path))).isFile() ? (await readFile(join(dir, path))).toString('hex') : 'dir']));
}
const present = async path => Boolean(await lstat(path).catch(() => null));
const expectedReceipt = (operation, plan, rows) => ({ schema: 1, id: operation, plan, artifacts: rows.map(({ id, digest, bytes }) => ({ id, digest, bytes })), reclaimedArtifactBytes: rows.reduce((sum, row) => sum + row.bytes, 0) });

// Report a lost unlink result after the real side effect in the later target.
// Only this process's unmanaged filesystem boundary is wrapped; production has no test hook.
async function interrupt(w) {
  const plan = await w.plan(), last = plan.candidates.at(-1), original = fsp.unlink;
  fsp.unlink = async path => {
    await original(path);
    if (path.startsWith(join(w.artifacts, last.id) + '/')) throw Object.assign(new Error('lost unlink result'), { code: 'EIO' });
  };
  syncBuiltinESMExports();
  try { await assert.rejects(w.c.pruneArtifacts(plan.plan), { code: 'ARTIFACT_PRUNE_INCOMPLETE' }); }
  finally { fsp.unlink = original; syncBuiltinESMExports(); }
  return { plan, last };
}

test('full quota: an approved prune of terminal releases reclaims bytes, records receipts and admits new uploads', async t => {
  const w = await world(t);
  const full = await w.reload({ maxArtifactBytes: w.c.quota.used });
  await assert.rejects(w.upload(full), /Retained artifact capacity reached/);
  const plan = await w.plan(full), kept = await tree(join(w.artifacts, w.active.id));
  assert.deepEqual(plan.candidates.map(row => row.id).sort(), [w.rejected.id, w.superseded.id].sort());
  w.calls.length = 0; w.writes.length = 0;
  const receipt = await full.pruneArtifacts(plan.plan);
  assert.deepEqual(receipt, expectedReceipt(receipt.id, plan.plan, plan.candidates));
  assert.deepEqual(w.calls, [], 'pruning never calls the backend');
  assert.equal(w.writes.length, 2, 'journal then completion');
  assert.deepEqual(w.writes[0].artifactPruning.operation.candidates.map(row => row.id), plan.candidates.map(row => row.id));
  assert.equal(await present(join(w.artifacts, w.rejected.id)), false);
  assert.equal(await present(join(w.artifacts, w.superseded.id)), false);
  assert.deepEqual(await tree(join(w.artifacts, w.active.id)), kept);
  assert.equal(full.quota.used, plan.protectedArtifactBytes);
  for (const row of plan.candidates) {
    assert.deepEqual(full.state.deployments[row.id].artifactPruned, { schema: 1, operation: receipt.id, bytes: row.bytes });
    assert.equal(full.state.deployments[row.id].status, row.status, 'history and status are retained');
  }
  assert.ok(full.state.requirements.includes('fogd-artifact-pruning-v1'));
  assert.deepEqual(await full.artifactPruneStatus(), { schema: 1, operation: null, last: receipt });

  // Repeats are idempotent and write nothing.
  w.writes.length = 0;
  assert.deepEqual(await full.pruneArtifacts(plan.plan), receipt);
  assert.deepEqual(await full.resumeArtifactPrune(receipt.id), receipt);
  await assert.rejects(full.resumeArtifactPrune(randomUUID()), { code: 'ARTIFACT_PRUNE_UNKNOWN' });
  await assert.rejects(full.resumeArtifactPrune('nope'), { code: 'ARTIFACT_PRUNE_UNKNOWN' });
  assert.deepEqual(w.writes, []);

  const after = await w.plan(full);
  assert.deepEqual(after.candidates, []);
  assert.deepEqual(after.missing.map(row => row.reasons), [['pruned'], ['pruned']]);
  const reloaded = await w.reload({ maxArtifactBytes: plan.retainedArtifactBytes });
  assert.deepEqual(await reloaded.artifactPruneStatus(), { schema: 1, operation: null, last: receipt });
  const next = await w.upload(reloaded);
  assert.equal(next.status, 'pending');
});

test('pins, active, unfinished, failed and unknown-status releases are never pruned', async t => {
  const w = await world(t);
  const failed = await w.upload(w.c), pending = await w.upload(w.c), unknown = await w.upload(w.c), loose = await w.upload(w.c);
  await w.c.mutate(loose.id, loose.digest, 'reject');
  failed.status = 'failed'; unknown.status = 'archived'; await w.c.save();
  await w.c.setArtifactPin(w.rejected.id, w.rejected.digest, true);
  const before = await tree(w.artifacts), plan = await w.plan();
  assert.deepEqual(plan.candidates.map(row => row.id).sort(), [w.superseded.id, loose.id].sort());
  const receipt = await w.c.pruneArtifacts(plan.plan);
  assert.deepEqual(receipt.artifacts.map(row => row.id).sort(), [w.superseded.id, loose.id].sort());
  const gone = new Set([w.superseded.id, loose.id]);
  assert.deepEqual(await tree(w.artifacts), before.filter(([path]) => !gone.has(path.split('/')[0])));
  for (const r of [w.rejected, w.active, failed, pending, unknown]) assert.equal(Object.hasOwn(w.c.state.deployments[r.id], 'artifactPruned'), false);
});

test('stale plans and empty plans refuse without writes or deletions', async t => {
  const changes = {
    bytes: async w => writeFile(join(w.artifacts, w.rejected.id, 'extra.txt'), 'x'),
    upload: async w => { await w.upload(w.c); },
    approval: async w => { const r = await w.upload(w.c); await w.c.mutate(r.id, r.digest, 'approve'); },
    pin: async w => { await w.c.setArtifactPin(w.rejected.id, w.rejected.digest, true); },
  };
  for (const [name, change] of Object.entries(changes)) {
    const w = await world(t), plan = await w.plan();
    await change(w);
    const before = await tree(w.artifacts), state = JSON.stringify(w.c.state); w.writes.length = 0;
    await assert.rejects(w.c.pruneArtifacts(plan.plan), { code: 'ARTIFACT_PRUNE_STALE' }, name);
    assert.deepEqual([w.writes, await tree(w.artifacts), JSON.stringify(w.c.state)], [[], before, state], name);
  }
  const w = await world(t);
  await w.c.pruneArtifacts((await w.plan()).plan);
  w.writes.length = 0;
  await assert.rejects(w.c.pruneArtifacts((await w.plan()).plan), { code: 'ARTIFACT_PRUNE_EMPTY' });
  await assert.rejects(w.c.pruneArtifacts('A'.repeat(64)), /reviewed retention plan hash/);
  assert.deepEqual(w.writes, []);
});

test('an interrupted removal stays pending, blocks ordinary work across reload, and only explicit resume completes it', async t => {
  const w = await world(t), { plan, last } = await interrupt(w);
  const pending = await w.c.artifactPruneStatus();
  assert.deepEqual(pending.operation.candidates, plan.candidates.map(({ id, digest, bytes }) => ({ id, digest, bytes })));
  assert.equal(pending.operation.approvedArtifactBytes, plan.reclaimableArtifactBytes);
  assert.equal(JSON.stringify(pending).includes('sha256'), false, 'public status hides file hashes');
  assert.equal(await present(join(w.artifacts, plan.candidates[0].id)), false, 'first target removed');
  assert.equal(await present(join(w.artifacts, last.id)), true, 'interrupted target partially kept');
  const blocked = async c => {
    await assert.rejects(w.upload(c), PENDING);
    await assert.rejects(c.mutate(w.active.id, w.active.digest, 'approve'), PENDING);
    await assert.rejects(c.setArtifactPin(w.active.id, w.active.digest, true), PENDING);
    await assert.rejects(c.issueCredential('ci', ['hello']), PENDING);
    await assert.rejects(c.replaceSecrets('hello', {}), PENDING);
    await assert.rejects(c.decideRoute('hello', 'reconcile', {}), PENDING);
    await assert.rejects(c.exclusive(() => 'plan'), PENDING);
    await assert.rejects(c.pruneArtifacts(plan.plan), PENDING);
    await assert.rejects(c.resumeArtifactPrune(randomUUID()), { code: 'ARTIFACT_PRUNE_UNKNOWN' });
    assert.throws(() => assertArtifactSnapshotReady(c.state), PENDING);
  };
  await blocked(w.c);
  const remaining = await tree(w.artifacts);
  const reloaded = await w.reload();
  assert.deepEqual(await tree(w.artifacts), remaining, 'startup never deletes');
  assert.deepEqual(await reloaded.artifactPruneStatus(), pending);
  await blocked(reloaded);
  w.calls.length = 0;
  const receipt = await reloaded.resumeArtifactPrune(pending.operation.id);
  assert.deepEqual(receipt, expectedReceipt(pending.operation.id, plan.plan, plan.candidates));
  assert.deepEqual(w.calls, []);
  assert.equal(await present(join(w.artifacts, last.id)), false);
  assert.equal(reloaded.quota.used, plan.protectedArtifactBytes);
  assert.deepEqual(await reloaded.resumeArtifactPrune(pending.operation.id), receipt);
  assert.equal((await w.upload(reloaded)).status, 'pending');
});

for (const [phase, fault] of [['journal', 'before'], ['journal', 'after'], ['completion', 'before'], ['completion', 'after']]) {
  test(`${phase} save failure ${fault} persist latches and reload shows the durable outcome`, async t => {
    const w = await world(t), plan = await w.plan(), before = await tree(w.artifacts);
    w.fail(value => (phase === 'journal' ? value.artifactPruning?.operation : value.artifactPruning?.last) ? fault : null);
    await assert.rejects(w.c.pruneArtifacts(plan.plan), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
    await assert.rejects(w.c.artifactPruneStatus(), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
    const deleted = phase === 'completion';
    assert.equal(await present(join(w.artifacts, w.rejected.id)), !deleted);
    if (!deleted) assert.deepEqual(await tree(w.artifacts), before, 'no deletion without a durable journal');
    const c = await w.reload(), status = await c.artifactPruneStatus();
    if (phase === 'journal' && fault === 'before') {
      assert.deepEqual(status, { schema: 1, operation: null, last: null });
      assert.equal(Object.hasOwn(c.state, 'artifactPruning'), false);
      const receipt = await c.pruneArtifacts(plan.plan);
      assert.equal(receipt.reclaimedArtifactBytes, plan.reclaimableArtifactBytes);
    } else if (phase === 'completion' && fault === 'after') {
      assert.equal(status.operation, null);
      assert.deepEqual(await c.resumeArtifactPrune(status.last.id), status.last);
    } else {
      assert.ok(status.operation);
      await assert.rejects(w.upload(c), PENDING);
      const receipt = await c.resumeArtifactPrune(status.operation.id);
      assert.deepEqual(receipt, expectedReceipt(status.operation.id, plan.plan, plan.candidates));
    }
    assert.equal(c.quota.used, plan.protectedArtifactBytes);
    assert.equal(await present(join(w.artifacts, w.rejected.id)), false);
  });
}

test('after partial deletion, newly referenced or tampered targets refuse resume without deleting anything', async t => {
  const w = await world(t), { last } = await interrupt(w);
  const id = (await w.c.artifactPruneStatus()).operation.id;
  w.c.state.futureField = { keep: last.id }; await w.c.save();
  let c = await w.reload(), remaining = await tree(w.artifacts);
  await assert.rejects(c.resumeArtifactPrune(id), { code: 'ARTIFACT_PRUNE_REFUSED' });
  assert.deepEqual(await tree(w.artifacts), remaining);

  delete c.state.futureField; await c.save();
  const row = (await artifactInventory(w.artifacts)).find(r => r.id === last.id);
  await writeFile(join(w.artifacts, last.id, row.files.at(-1).path), 'tampered');
  c = await w.reload(); remaining = await tree(w.artifacts);
  await assert.rejects(c.resumeArtifactPrune(id), { code: 'ARTIFACT_PRUNE_REFUSED' });
  assert.deepEqual(await tree(w.artifacts), remaining);
  assert.ok((await c.artifactPruneStatus()).operation, 'still pending, no automatic retry');

  // An operator pin cannot be added to a pending target, even by editing metadata.
  const state = await readJson(join(w.dir, 'state.json'));
  await saveJson(join(w.dir, 'state.json'), { ...state, artifactPins: { schema: 1, releases: { [last.id]: last.digest } } });
  await assert.rejects(w.reload(), { code: 'ARTIFACT_PRUNING_INVALID' });
});

test('pruned bytes that reappear are retained for review, not deleted again', async t => {
  const w = await world(t);
  await w.c.pruneArtifacts((await w.plan()).plan);
  await mkdir(join(w.artifacts, w.rejected.id));
  await writeFile(join(w.artifacts, w.rejected.id, 'index.js'), 'back');
  const plan = await w.plan(), row = plan.protected.find(r => r.id === w.rejected.id);
  assert.deepEqual(plan.candidates, []);
  assert.ok(row.reasons.includes('pruned'));
  await assert.rejects(w.c.setArtifactPin(w.rejected.id, w.rejected.digest, true), /Pruned artifact history cannot be pinned/);
  assert.equal(Object.hasOwn(w.c.state, 'artifactPins'), false);
});

test('malformed pruning metadata, capability or markers refuse startup without writes or backend calls', async t => {
  const w = await world(t);
  const receipt = await w.c.pruneArtifacts((await w.plan()).plan), path = join(w.dir, 'state.json');
  const good = await readJson(path), target = receipt.artifacts[0];
  const edit = fn => { const s = structuredClone(good); fn(s); return s; };
  const cap = 'fogd-artifact-pruning-v1';
  const op = { id: randomUUID(), plan: receipt.plan, candidates: [{ id: w.active.id, digest: w.active.digest, bytes: 0, files: [], directories: [] }] };
  const cases = {
    'field without capability': edit(s => { s.requirements = s.requirements.filter(r => r !== cap); }),
    'capability without field': edit(s => { delete s.artifactPruning; for (const d of Object.values(s.deployments)) delete d.artifactPruned; }),
    'marker without field': edit(s => { delete s.artifactPruning; s.requirements = s.requirements.filter(r => r !== cap); }),
    'schema': edit(s => { s.artifactPruning.schema = 2; }),
    'extra key': edit(s => { s.artifactPruning.force = true; }),
    'receipt sum': edit(s => { s.artifactPruning.last.reclaimedArtifactBytes++; }),
    'receipt digest': edit(s => { s.artifactPruning.last.artifacts[0].digest = 'a'.repeat(64); }),
    'marker operation': edit(s => { s.deployments[target.id].artifactPruned.operation = randomUUID(); }),
    'marker on active': edit(s => { s.deployments[w.active.id].artifactPruned = { schema: 1, operation: receipt.id, bytes: 1 }; }),
    'pinned marker': edit(s => { s.artifactPins = { schema: 1, releases: { [target.id]: target.digest } }; }),
    'active target': edit(s => { s.artifactPruning.operation = op; }),
    'unknown target': edit(s => { s.artifactPruning.operation = { ...op, candidates: [{ ...op.candidates[0], id: randomUUID() }] }; }),
    'malformed target': edit(s => { s.artifactPruning.operation = { ...op, candidates: [{ id: target.id }] }; }),
    'reused operation id': edit(s => { s.artifactPruning.operation = { ...op, id: receipt.id, candidates: [{ ...op.candidates[0], id: w.rejected.id, digest: w.rejected.digest }] }; }),
  };
  for (const [name, state] of Object.entries(cases)) {
    await saveJson(path, state);
    w.calls.length = 0; w.writes.length = 0;
    const before = await tree(w.artifacts);
    await assert.rejects(w.reload(), { code: 'ARTIFACT_PRUNING_INVALID' }, name);
    assert.deepEqual([w.calls, w.writes, await tree(w.artifacts)], [[], [], before], name);
    assert.throws(() => validateArtifactPruning(state), { code: 'ARTIFACT_PRUNING_INVALID' }, name);
  }
  await saveJson(path, good);
  assert.deepEqual(artifactPruneStatus((await w.reload()).state).last, receipt);
});
