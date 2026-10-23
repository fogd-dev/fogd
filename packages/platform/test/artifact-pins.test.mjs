import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, lstat, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, slots } from './fixtures/queue-controller.mjs';
import { Controller } from '../src/controller.mjs';
import { planArtifactRetention } from '../src/artifact-retention.mjs';
import { validateArtifactPins } from '../src/artifact-pins.mjs';
import { readJson, saveJson } from '../src/store.mjs';

const approve = (c, r) => c.mutate(r.id, r.digest, 'approve');
const byId = rows => Object.fromEntries(rows.map(row => [row.id, row]));
const plan = c => planArtifactRetention(c.state, join(c.dir, 'artifacts'));
const keep = (c, r, kept = true) => c.setArtifactPin(r.id, r.digest, kept);

// Counts metadata writes through the fixture's real persist wrapper.
function writes(f, fault = () => null) {
  const seen = [];
  f.failWrite(value => { seen.push(structuredClone(value)); return fault(value); });
  return seen;
}

async function snapshot(c) {
  const files = await readdir(c.dir, { recursive: true });
  const rows = await Promise.all(files.sort().map(async path => {
    const info = await lstat(join(c.dir, path));
    return [path, info.isFile() ? (await readFile(join(c.dir, path))).toString('hex') : info.mode];
  }));
  return { files: rows, state: structuredClone(c.state) };
}

// rejected, superseded (references rejected), active.
async function releases(f) {
  const rejected = await f.request(); await f.c.mutate(rejected.id, rejected.digest, 'reject');
  const superseded = await f.request(); await approve(f.c, superseded);
  const active = await f.request(); await approve(f.c, active);
  superseded.previous = rejected.id; await f.c.save();
  assert.deepEqual([rejected.status, superseded.status, active.status], ['rejected', 'superseded', 'active']);
  return { rejected, superseded, active };
}

test('keeping terminal releases protects them and their references, survives reload, and unkeep restores candidates', async t => {
  const f = await fixture(t), { rejected, superseded, active } = await releases(f);
  const before = await plan(f.c);
  assert.deepEqual(before.candidates.map(row => row.id).sort(), [rejected.id, superseded.id].sort());
  assert.deepEqual(await keep(f.c, superseded), { schema: 1, id: superseded.id, digest: superseded.digest, kept: true });
  const pinned = await plan(f.c);
  assert.notEqual(pinned.plan, before.plan);
  assert.deepEqual(pinned.candidates, []);
  assert.deepEqual(byId(pinned.protected)[superseded.id].reasons, ['operator-pin']);
  assert.deepEqual(byId(pinned.protected)[rejected.id].reasons, ['deployment-reference']);
  assert.deepEqual((await readJson(join(f.c.dir, 'state.json'))).artifactPins, { schema: 1, releases: { [superseded.id]: superseded.digest } });

  const reloaded = f.create(); await reloaded.init();
  assert.deepEqual(reloaded.state.artifactPins, f.c.state.artifactPins);
  assert.equal((await plan(reloaded)).plan, pinned.plan);

  await keep(reloaded, active);
  assert.deepEqual(byId((await plan(reloaded)).protected)[active.id].reasons, ['active', 'operator-pin', 'controller-reference']);
  await keep(reloaded, superseded, false); await keep(reloaded, active, false);
  const unkept = await plan(reloaded);
  assert.deepEqual(reloaded.state.artifactPins, { schema: 1, releases: {} });
  assert.equal(unkept.plan, before.plan);
  assert.deepEqual(byId(unkept.protected)[active.id].reasons, ['active', 'controller-reference']);
});

test('pins report missing and corrupt artifacts without dropping the pin', async t => {
  const f = await fixture(t), { rejected, superseded } = await releases(f);
  await keep(f.c, rejected); await keep(f.c, superseded);
  await writeFile(join(f.c.artifact(rejected.id), 'worker/index.js'), 'tampered');
  await rm(f.c.artifact(superseded.id), { recursive: true });
  const result = await plan(f.c);
  assert.deepEqual(byId(result.protected)[rejected.id].reasons, ['operator-pin', 'deployment-reference', 'digest-mismatch']);
  assert.deepEqual(result.missing, [{ id: superseded.id, app: 'imports', digest: superseded.digest, status: 'superseded', reasons: ['operator-pin'] }]);
  const seen = writes(f);
  assert.deepEqual(await keep(f.c, superseded, false), { schema: 1, id: superseded.id, digest: superseded.digest, kept: false });
  assert.deepEqual(await keep(f.c, rejected, false), { schema: 1, id: rejected.id, digest: rejected.digest, kept: false });
  assert.equal(seen.length, 2);
  assert.deepEqual(f.c.state.artifactPins, { schema: 1, releases: {} });
});

test('repeated keep and unkeep perform no metadata writes and absent pins never create metadata', async t => {
  const f = await fixture(t), { rejected } = await releases(f), seen = writes(f);
  await keep(f.c, rejected, false);
  assert.equal(seen.length, 0); assert.equal(Object.hasOwn(f.c.state, 'artifactPins'), false);
  await keep(f.c, rejected); await keep(f.c, rejected);
  await keep(f.c, rejected, false); await keep(f.c, rejected, false);
  assert.equal(seen.length, 2);
});

test('malformed arguments and unknown identities are refused without writes', async t => {
  const f = await fixture(t), { rejected } = await releases(f), seen = writes(f), before = await snapshot(f.c);
  for (const [id, digest, kept] of [
    ['nope', rejected.digest, true], [rejected.id.toUpperCase(), rejected.digest, true], [rejected.id, rejected.digest.toUpperCase(), true],
    [rejected.id, rejected.digest, 'true'], [rejected.id, rejected.digest, undefined], [rejected.id, rejected.digest, 1],
    [rejected.id, 'f'.repeat(64), true], [randomUUID(), rejected.digest, true], [randomUUID(), rejected.digest, false],
    [`../${rejected.id}`, rejected.digest, true], [null, null, true],
  ]) await assert.rejects(f.c.setArtifactPin(id, digest, kept), /requires a deployment id|Deployment\/digest mismatch/, String(id));
  assert.equal(seen.length, 0); assert.deepEqual(await snapshot(f.c), before);
});

test('mismatched, missing, linked and special artifacts refuse keep without state or disk effects', async t => {
  const f = await fixture(t), artifacts = join(f.c.dir, 'artifacts'), outside = join(f.c.dir, 'outside');
  await writeFile(outside, 'outside');
  const sabotage = [
    path => writeFile(join(path, 'worker/index.js'), 'tampered'),
    path => rm(path, { recursive: true }),
    path => symlink(outside, join(path, 'worker/leak.js')),
    path => link(outside, join(path, 'worker/hard.js')),
    async path => execFileSync('mkfifo', [join(path, 'worker/pipe')]),
    async path => { await rename(path, `${path}-real`); await symlink(`${path}-real`, path); },
  ];
  const targets = [];
  for (const damage of sabotage) { const r = await f.request(); await damage(f.c.artifact(r.id)); targets.push(r); }
  const seen = writes(f), before = await snapshot(f.c);
  for (const r of targets) await assert.rejects(keep(f.c, r), /Stored artifact digest mismatch|^Error: Cannot inventory retained artifacts/);
  await rename(artifacts, `${artifacts}-real`); await symlink(`${artifacts}-real`, artifacts);
  await assert.rejects(keep(f.c, targets[0]), /^Error: Cannot inventory retained artifacts/);
  await rm(artifacts); await rename(`${artifacts}-real`, artifacts);
  assert.equal(seen.length, 0); assert.deepEqual(await snapshot(f.c), before);
});

test('unrelated links and special files do not prevent a valid pin', async t => {
  const f = await fixture(t), { rejected } = await releases(f), other = await f.request();
  await symlink(join(f.c.dir, 'state.json'), join(f.c.dir, 'artifacts/orphan-link'));
  execFileSync('mkfifo', [join(f.c.artifact(other.id), 'worker/pipe')]);
  await keep(f.c, rejected);
  assert.deepEqual(f.c.state.artifactPins.releases, { [rejected.id]: rejected.digest });
  await assert.rejects(plan(f.c), /Cannot inventory retained artifacts/);
});

for (const [fault, persisted] of [['before', false], ['after', true]]) {
  test(`pin save failure ${fault} persist latches the controller and reload shows the durable result`, async t => {
    const f = await fixture(t), { rejected } = await releases(f);
    writes(f, value => value.artifactPins ? fault : null);
    await assert.rejects(keep(f.c, rejected), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
    await assert.rejects(keep(f.c, rejected, false), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
    await assert.rejects(approve(f.c, rejected), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
    f.failWrite(null);
    const reloaded = f.create(); await reloaded.init();
    assert.deepEqual(validateArtifactPins(reloaded.state), persisted ? { [rejected.id]: rejected.digest } : {});
    assert.equal(Object.hasOwn(reloaded.state, 'artifactPins'), persisted);
  });
}

test('approval and keep are serialized through the controller queue', async t => {
  const f = await fixture(t), { rejected } = await releases(f), next = await f.request(), seen = writes(f);
  const approval = approve(f.c, next), pin = keep(f.c, rejected);
  await Promise.all([approval, pin]);
  const first = seen.findIndex(value => value.artifactPins);
  assert.equal(first, seen.length - 1, 'pin write follows every approval write');
  assert.equal(seen[first].deployments[next.id].status, 'active');
  assert.ok(seen.slice(0, first).every(value => !value.artifactPins));

  const later = await f.request(); seen.length = 0;
  await Promise.all([keep(f.c, rejected, false), approve(f.c, later)]);
  assert.deepEqual(seen[0].artifactPins.releases, {});
  assert.equal(seen[0].deployments[later.id].status, 'pending');
  assert.ok(seen.every(value => Object.keys(value.artifactPins.releases).length === 0));
});

test('malformed stored pins refuse startup and planning before writes or backend calls', async t => {
  const f = await fixture(t), { rejected } = await releases(f), path = join(f.c.dir, 'state.json');
  const stored = await readJson(path), digest = rejected.digest;
  const cases = [
    null, [], 'pins', {}, { schema: 1 }, { releases: {} }, { schema: 2, releases: {} }, { schema: '1', releases: {} },
    { schema: 1, releases: [] }, { schema: 1, releases: null }, { schema: 1, releases: {}, at: 1 },
    { schema: 1, releases: { [rejected.id]: digest.toUpperCase() } }, { schema: 1, releases: { [rejected.id.toUpperCase()]: digest } },
    { schema: 1, releases: { [rejected.id]: 'a'.repeat(64) } }, { schema: 1, releases: { [randomUUID()]: digest } },
    { schema: 1, releases: { [rejected.id]: true } }, { schema: 1, releases: { [rejected.id]: { digest } } },
  ];
  for (const artifactPins of cases) {
    await saveJson(path, { ...stored, artifactPins });
    const before = await snapshot(f.c), calls = [];
    const backend = new Proxy({}, { get: (_, key) => ['crons', 'queues', 'then'].includes(key) ? undefined : (...args) => { calls.push(key); return f.backend[key](...args); } });
    let persisted = 0;
    const c = new Controller({ queueApps: true, dir: f.c.dir, slots, backend, persist: async () => { persisted++; }, reportStorageFailure: () => {} });
    await assert.rejects(c.init(), { code: 'ARTIFACT_PINS_INVALID', message: 'Controller artifact pins are malformed; restore a consistent state.json' }, JSON.stringify(artifactPins));
    assert.deepEqual([calls, persisted], [[], 0]);
    assert.deepEqual((await snapshot(f.c)).files, before.files);
    const state = await readJson(path);
    assert.deepEqual(state.artifactPins, artifactPins);
    await assert.rejects(planArtifactRetention(state, join(f.c.dir, 'artifacts')), { code: 'ARTIFACT_PINS_INVALID' });
  }
});

test('stored pins without the field and with an empty map are valid and leave the no-pin plan unchanged', async t => {
  const f = await fixture(t); await releases(f);
  const without = await plan(f.c);
  f.c.state.artifactPins = { schema: 1, releases: {} };
  assert.deepEqual(await plan(f.c), without);
  assert.deepEqual(validateArtifactPins({ deployments: {} }), {});
});

for (const state of [null, [], { artifactPins: { schema: 1, releases: {} } }, { deployments: [], artifactPins: { schema: 1, releases: {} } }]) {
  test(`pin validation refuses malformed state with a fixed error: ${JSON.stringify(state)}`, () => {
    assert.throws(() => validateArtifactPins(state), { code: 'ARTIFACT_PINS_INVALID' });
  });
}
