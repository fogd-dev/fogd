import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { artifactDigest } from '@fogd/runtime/artifact';
import { Controller } from '../src/controller.mjs';
import { readRouteRecord, writeRouteRecord } from '../src/route-record-store.mjs';
import { runtimePolicyIdentity } from '../src/runtime-policy.mjs';
import { validateRouteSnapshot } from '../src/route-snapshot.mjs';
import { seedRouteStores } from './fixtures/route-stores.mjs';
import { policy as nativePolicy } from './fixtures/runtime-policy.mjs';

const refused = error => error.code === 'ROUTE_SNAPSHOT_REFUSED' && error.message === 'Route source snapshot is inconsistent; keep the installation stopped' && error.cause === undefined;
const durableProfile = () => ({ ...nativePolicy(), schema: 3, routing: 'durable', controllerArgs: ['packages/platform/src/main-durable.mjs'] });

// A real controller whose route installation is derived from the durable profile,
// so every record below is canonical bytes written by the production publisher.
async function installation(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-route-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'private'), authority = join(root, 'authority'); await mkdir(authority, { mode: 0o755 });
  const path = join(authority, 'routes.json'), statePath = join(dir, 'state.json'), profile = durableProfile();
  const slots = profile.fleets.map(({ id, prefix, nodes }) => ({ id, prefix, nodes: nodes.map(node => node.host) }));
  const policy = { installation: runtimePolicyIdentity(profile), slots: slots.map(slot => slot.id) }, owners = {}, versions = {};
  const backend = {
    owner: async slot => owners[slot.id] || null, hasDeployment: async slot => Boolean(versions[slot.id]), assertUnclaimed: async () => {},
    async claim(slot, app) { owners[slot.id] = { app }; }, async publish(slot) { return versions[slot.id] = randomUUID(); },
    ready: async () => {}, applicationReady: async () => {}, migrate: async () => {}, applied: async () => [],
  };
  const routeAuthority = { path, policy, verifyRuntime: async () => {} };
  await seedRouteStores(dir, routeAuthority);
  const c = new Controller({ dir, slots, backend, routeAuthority, reportStorageFailure: () => {} }); await c.init();
  async function request(app = 'alpha') {
    const id = randomUUID(), artifact = c.artifact(id); await mkdir(artifact, { recursive: true });
    await writeFile(join(artifact, 'index.js'), `// ${id}\nexport default {fetch(){return new Response('ok')}}`);
    await writeFile(join(artifact, 'wrangler.json'), JSON.stringify({ name: app, main: 'index.js', d1_databases: [] }));
    const value = { id, app, digest: await artifactDigest(artifact), resources: { script: app, d1: [], r2: [], durable: { bindings: [] } }, migrations: [], requiredSecrets: [], status: 'pending', step: 'submitted' };
    c.state.deployments[id] = value; await c.save(); return value;
  }
  const approve = async app => { const value = await request(app); await c.mutate(value.id, value.digest, 'approve'); return value; };
  const snapshot = async () => ({ state: JSON.parse(await readFile(statePath, 'utf8')), observed: await readRouteRecord(path, policy) });
  // Publishes a changed record through the canonical writer and settles it only in
  // the returned private copy: a byte-consistent journal over semantically wrong routes.
  async function settled(state, record) {
    await writeRouteRecord(path, record, policy); const observed = await readRouteRecord(path, policy);
    state.routeAuthority.settled = { revision: observed.record.revision, digest: observed.digest };
    return observed;
  }
  return { c, path, policy, profile, approve, snapshot, settled };
}
async function active(t) {
  const f = await installation(t); return { ...f, alpha: await f.approve('alpha'), beta: await f.approve('beta') };
}
const check = ({ state, observed }, profile, domain) => validateRouteSnapshot(state, observed, profile, domain);

test('active routes return the settled public reference over real canonical bytes', async t => {
  const f = await active(t), pair = await f.snapshot(), bytes = await readFile(f.path);
  assert.deepEqual(pair.observed.record.routes.map(route => [route.host, route.state, route.submission]), [['alpha.localhost', 'active', f.alpha.id], ['beta.localhost', 'active', f.beta.id]]);
  assert.deepEqual(check(pair, f.profile), { schema: 1, installation: f.policy.installation, revision: pair.observed.record.revision, sha256: createHash('sha256').update(bytes).digest('hex') });
  assert.equal(pair.state.routeAuthority.settled.digest, pair.observed.digest);
});
test('a paused app publishes a withheld route and the pair remains consistent', async t => {
  const f = await active(t); await f.c.decideRoute('alpha', 'pause', { deployment: f.alpha.id, digest: f.alpha.digest });
  const pair = await f.snapshot();
  assert.equal(pair.observed.record.routes[0].state, 'withheld');
  assert.equal(check(pair, f.profile).sha256, pair.observed.digest);
});
test('an empty installation validates at revision zero', async t => {
  const f = await installation(t), pair = await f.snapshot();
  assert.deepEqual(check(pair, f.profile), { schema: 1, installation: f.policy.installation, revision: '0', sha256: pair.observed.digest });
});
test('a stale public record against a later settled journal refuses', async t => {
  const f = await installation(t); await f.approve('alpha'); const stale = await f.snapshot();
  await f.approve('beta'); const current = await f.snapshot();
  assert.throws(() => check({ state: current.state, observed: stale.observed }, f.profile), refused);
  assert.throws(() => check({ state: stale.state, observed: current.observed }, f.profile), refused);
});
test('a mismatched settled digest or revision refuses', async t => {
  const f = await active(t);
  for (const change of [settled => { settled.digest = 'f'.repeat(64); }, settled => { settled.revision = String(BigInt(settled.revision) + 1n); }]) {
    const pair = await f.snapshot(); change(pair.state.routeAuthority.settled);
    assert.throws(() => check(pair, f.profile), refused);
  }
});
test('an unresolved pending publication refuses even when public bytes reached the target', async t => {
  const f = await installation(t), pair = await f.snapshot(), record = { ...pair.observed.record, revision: '1' };
  const observed = await f.settled(pair.state, record);
  assert.equal(check({ state: pair.state, observed }, f.profile).revision, '1');
  pair.state.routeAuthority.pending = { id: 'withhold:1', kind: 'withhold', app: 'alpha', approval: null, previous: null, record, digest: observed.digest };
  assert.throws(() => check({ state: pair.state, observed }, f.profile), refused);
});
test('foreign or non-durable profiles refuse', async t => {
  const f = await active(t), pair = await f.snapshot();
  const foreign = durableProfile(); foreign.bucket = 'another';
  const legacy = nativePolicy();
  const routing = durableProfile(); routing.routing = 'legacy';
  for (const profile of [foreign, legacy, routing, null, { ...durableProfile(), extra: true }]) assert.throws(() => check(pair, profile), refused);
});
test('a wrong domain refuses every published host', async t => {
  const f = await active(t), pair = await f.snapshot(); assert.throws(() => check(pair, f.profile, 'example.test'), refused);
});
test('missing or stale private approvals refuse', async t => {
  const f = await active(t), missing = await f.snapshot();
  delete missing.state.deployments[f.alpha.id];
  assert.throws(() => check(missing, f.profile), refused);
  const before = await f.snapshot(); await f.approve('alpha');
  const after = await f.snapshot(), observed = await f.settled(after.state, { ...before.observed.record, revision: String(BigInt(after.observed.record.revision) + 1n) });
  assert.equal(observed.record.routes[0].submission, f.alpha.id);
  assert.throws(() => check({ state: after.state, observed }, f.profile), refused);
  const incomplete = await f.snapshot(); incomplete.state.deployments[incomplete.state.apps.alpha.active].step = 'migrated';
  assert.throws(() => check(incomplete, f.profile), refused);
});
test('held apps cannot keep an active public route', async t => {
  const f = await active(t);
  for (const hold of [state => { state.routeAuthority.holds.alpha = { id: f.alpha.id, digest: f.alpha.digest }; }, state => { state.apps.alpha.queueRecovery = { status: 'pending' }; }, state => { state.apps.alpha.route = 'paused'; }]) {
    const pair = await f.snapshot(); hold(pair.state);
    assert.throws(() => check(pair, f.profile), refused);
  }
});
test('withheld public routes require a private hold', async t => {
  const f = await active(t), pair = await f.snapshot(), record = structuredClone(pair.observed.record);
  record.revision = String(BigInt(record.revision) + 1n); record.routes[0] = { host: 'alpha.localhost', state: 'withheld', slot: record.routes[0].slot };
  const observed = await f.settled(pair.state, record);
  assert.throws(() => check({ state: pair.state, observed }, f.profile), refused);
});
test('serving apps missing from settled public authority refuse', async t => {
  const f = await active(t), pair = await f.snapshot();
  for (const routes of [[], pair.observed.record.routes.slice(1)]) {
    const state = structuredClone(pair.state), record = { ...pair.observed.record, revision: String(BigInt(pair.observed.record.revision) + 1n), routes };
    const observed = await f.settled(state, record);
    assert.throws(() => check({ state, observed }, f.profile), refused);
  }
});
test('observations other than an exact canonical record and digest refuse', async t => {
  const f = await active(t), pair = await f.snapshot();
  const variants = [null, { record: pair.observed.record }, { ...pair.observed, extra: true }, { ...pair.observed, digest: pair.observed.digest.toUpperCase() },
    { record: { ...pair.observed.record, extra: true }, digest: pair.observed.digest }];
  for (const observed of variants) assert.throws(() => validateRouteSnapshot(pair.state, observed, f.profile), refused);
  const nonCanonical = Buffer.from(JSON.stringify(pair.observed.record));
  assert.throws(() => validateRouteSnapshot(pair.state, { record: pair.observed.record, digest: createHash('sha256').update(nonCanonical).digest('hex') }, f.profile), refused);
});
test('unknown private capabilities refuse', async t => {
  const f = await active(t), pair = await f.snapshot(); pair.state.requirements.push('fogd-unknown-v9');
  assert.throws(() => check(pair, f.profile), refused);
});
