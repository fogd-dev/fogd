import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { capacity } from '../src/capacity.mjs';
import { Controller } from '../src/controller.mjs';
import { server } from '../src/http.mjs';
import { stageArtifact } from '@fogd/runtime/artifact';
import { manifest } from '@fogd/runtime/manifest';

const slots = [{ id: 'slot-1', prefix: 'one', nodes: ['a', 'b'] }, { id: 'slot-2', prefix: 'two', nodes: ['c', 'd'] }];
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'fogd-platform-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owners = {}, applied = {}; let publishes = 0;
  const backend = {
    owner: async slot => owners[slot.id] || null,
    claim: async (slot, app) => { if (owners[slot.id]?.app && owners[slot.id].app !== app) throw Error('Slot owner mismatch'); owners[slot.id] = { app }; },
    publish: async () => { publishes++; return 'version'; },
    ready: async () => {},
    applicationReady: async () => {},
    migrate: async (slot, dir, resources) => {
      for (const db of resources.d1) {
        const files = (await import('node:fs/promises')).readdir;
        for (const name of (await files(join(dir, db.migrations_dir))).sort()) {
          if ((await readFile(join(dir, db.migrations_dir, name), 'utf8')) === 'BAD SQL') throw Error('SQL failed');
          const rows = applied[slot.id] ||= [];
          if (!rows.some(m => m.name === name)) rows.push({ database: db.database_id, name });
        }
      }
    },
    applied: async slot => applied[slot.id] || [],
  };
  const controller = new Controller({ dir: join(root, 'state'), slots, backend }); await controller.init();
  let sequence = 0;
  const artifact = async (app = 'hello', sql = ['CREATE TABLE test (id TEXT);'], resources = {}) => {
    const dir = join(root, `project-${sequence++}`); await mkdir(join(dir, 'dist/ssr'), { recursive: true }); await mkdir(join(dir, 'db/migrations'), { recursive: true });
    await writeFile(join(dir, 'dist/ssr/index.js'), 'export default {fetch(){return new Response("ok")}}');
    await writeFile(join(dir, 'dist/ssr/wrangler.json'), JSON.stringify({ main: 'index.js', d1_databases: [{ binding: 'DB' }], ...resources }));
    for (const [index, content] of sql.entries()) await writeFile(join(dir, 'db/migrations', `000${index + 1}_init.sql`), content);
    const outputDir = join(dir, 'artifact'); const release = await stageArtifact({ projectDir: dir, outputDir, app });
    return manifest(outputDir, release);
  };
  return { root, controller, backend, owners, artifact, publishes: () => publishes };
}

test('pending/rejected bytes never publish; exact approval activates two isolated hostnames', async t => {
  const { controller: c, artifact, publishes } = await setup(t);
  const a = await c.submit(await artifact(), 'team-token');
  assert.equal(c.route('hello.localhost').state, 'unknown'); assert.equal(publishes(), 0);
  await assert.rejects(c.mutate(a.id, '0'.repeat(64), 'approve'), /digest/);
  await c.mutate(a.id, a.digest, 'reject'); assert.equal(publishes(), 0);
  const b = await c.submit(await artifact(), 'team-token'); await c.mutate(b.id, b.digest, 'approve');
  const other = await c.submit(await artifact('second'), 'team-token'); await c.mutate(other.id, other.digest, 'approve');
  assert.equal(c.route('hello.localhost').state, 'active');
  assert.notEqual(c.route('hello.localhost').slot, c.route('second.localhost').slot);
  assert.equal(c.route('hello.localhost.evil').state, 'unknown');
  await assert.rejects(c.submit(await artifact('third'), 'team-token'), /slots/);
});

test('rejects traversal, excluded metadata, nested config, bad digest and duplicates', async t => {
  const { controller: c, artifact } = await setup(t);
  for (const path of ['../secret', 'worker/../secret', 'fogd-release.json', '/secret', 'worker\\secret']) {
    const body = await artifact(); body.files.push({ path, data: 'eA==' }); await assert.rejects(c.submit(body, 'team-token'), /path/);
  }
  const bad = await artifact(); bad.digest = '0'.repeat(64); await assert.rejects(c.submit(bad, 'team-token'), /digest/);
  const duplicate = await artifact(); duplicate.files.push(duplicate.files[0]); await assert.rejects(c.submit(duplicate, 'team-token'), /Duplicate/);
  const nested = await artifact(); const file = nested.files.find(f => f.path === 'wrangler.json'); const config = JSON.parse(Buffer.from(file.data, 'base64')); config.durable_objects = { bindings: [{ name: '../DB', class_name: 'Unsafe', script_name: 'other' }] }; file.data = Buffer.from(JSON.stringify(config)).toString('base64');
  await assert.rejects(c.submit(nested, 'team-token'), /identifier/);
});

test('partial migration failure preserves applied hashes but allows correction of unapplied SQL', async t => {
  const { controller: c, artifact } = await setup(t);
  const failed = await c.submit(await artifact('hello', ['CREATE TABLE test(id TEXT);', 'BAD SQL']), 'team-token');
  await c.mutate(failed.id, failed.digest, 'approve');
  assert.equal(failed.status, 'failed'); assert.equal(c.route('hello.localhost').state, 'paused');
  assert.equal(c.state.apps.hello.migrations.length, 1);
  await assert.rejects(c.submit(await artifact('hello', ['CHANGED', 'fixed']), 'team-token'), /Applied migration/);
  const fixed = await c.submit(await artifact('hello', ['CREATE TABLE test(id TEXT);', 'fixed']), 'team-token');
  await c.mutate(fixed.id, fixed.digest, 'approve'); assert.equal(fixed.status, 'active');
});

test('interruptions stay paused, require explicit retry, and reconcile attempted migrations', async t => {
  const { controller: c, artifact, backend } = await setup(t);
  const d = await c.submit(await artifact(), 'team-token');
  backend.ready = async () => { throw Error('Replica down'); };
  await c.mutate(d.id, d.digest, 'approve'); assert.equal(d.status, 'failed');
  d.status = 'activating'; await c.save();
  const restarted = new Controller({ dir: c.dir, slots, backend }); await restarted.init();
  assert.equal(restarted.state.deployments[d.id].status, 'failed'); assert.equal(restarted.route('hello.localhost').state, 'paused');
  backend.ready = async () => {};
  await restarted.mutate(d.id, d.digest, 'approve'); assert.equal(restarted.route('hello.localhost').state, 'active');
  const restored = new Controller({ dir: c.dir, slots, backend }); await restored.init(); assert.equal(restored.route('hello.localhost').state, 'active');
});

test('lost controller metadata quarantines bucket owners and prevents slot reassignment', async t => {
  const { controller: c, artifact, backend } = await setup(t);
  const d = await c.submit(await artifact(), 'team-token'); await c.mutate(d.id, d.digest, 'approve');
  await rm(join(c.dir, 'state.json'));
  const fresh = new Controller({ dir: c.dir, slots, backend }); await fresh.init();
  assert.equal(fresh.route('hello.localhost').state, 'paused');
  assert.equal(fresh.state.apps.hello.quarantined, true);
  assert.equal(fresh.available('different').id, 'slot-2');
  const report = capacity(fresh);
  assert.equal(report.slots.available, 1);
  assert.deepEqual(report.slots.items[0], { id: 'slot-1', bucketOwner: 'hello', occupied: true, assignments: [{ app: 'hello', route: 'paused', quarantined: true }] });
  await assert.rejects(fresh.submit(await artifact(), 'team-token'), /quarantined/);
});

test('HTTP separates submitter/admin/gateway rights and requires CSRF plus exact digest', async t => {
  const { controller: c, artifact, publishes, backend } = await setup(t);
  const http = server(c, { user: 'admin', password: 'password', deploy: 'deploy', gateway: 'gateway' });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const base = `http://127.0.0.1:${http.address().port}`;
  const auth = `Basic ${Buffer.from('admin:password').toString('base64')}`;
  const post = (path, authorization, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { authorization, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/')).status, 401);
  assert.equal((await fetch(base + '/v1/admin', { headers: { authorization: 'Bearer deploy' } })).status, 401);
  assert.equal((await post('/v1/deployments', 'Bearer bad', await artifact())).status, 401);
  const d = await (await post('/v1/deployments', 'Bearer deploy', await artifact())).json();
  const statusPath = `/v1/deployments/${d.id}`;
  for (const authorization of ['Bearer bad', 'Bearer gateway', '']) {
    assert.equal((await fetch(base + statusPath, { headers: { authorization } })).status, 401);
  }
  const inspect = async id => fetch(`${base}/v1/deployments/${id}`, { headers: { authorization: 'Bearer deploy' } });
  const pending = await inspect(d.id);
  assert.equal(pending.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await pending.json(), { id: d.id, app: d.app, digest: d.digest, status: 'pending', submittedAt: d.submittedAt, step: 'submitted', error: null });
  assert.equal((await inspect('00000000-0000-0000-0000-000000000000')).status, 404);
  const credential = await c.issueCredential('Another submitter', ['other']);
  const other = await c.submit(await artifact('other'), credential.id);
  assert.equal((await inspect(other.id)).status, 404);
  assert.equal((await fetch(base + statusPath + '/artifact', { headers: { authorization: 'Bearer deploy' } })).status, 401);
  const path = `/v1/deployments/${d.id}/approve`;
  assert.equal((await post(path, 'Bearer deploy', { digest: d.digest })).status, 401);
  assert.equal((await post(path, auth, { digest: d.digest })).status, 403);
  const { csrf } = await (await fetch(base + '/v1/admin', { headers: { authorization: auth } })).json();
  assert.equal((await post(path, auth, { digest: d.digest }, { 'X-Fogd-CSRF': csrf, Origin: 'http://evil.test' })).status, 403);
  assert.equal(publishes(), 0);
  const result = await post(path, auth, { digest: d.digest }, { 'X-Fogd-CSRF': csrf }); assert.equal(result.status, 200); assert.equal((await result.json()).status, 'active');
  assert.equal((await (await inspect(d.id)).json()).status, 'active');
  backend.migrate = async () => { throw new Error('SQL containing secret=private-test-value'); };
  const failed = await (await post('/v1/deployments', 'Bearer deploy', await artifact())).json();
  await post(`/v1/deployments/${failed.id}/approve`, auth, { digest: failed.digest }, { 'X-Fogd-CSRF': csrf });
  const failure = await (await inspect(failed.id)).json();
  assert.equal(failure.status, 'failed'); assert.equal(failure.step, 'migrating');
  assert.match(failure.error, /migration failed/);
  assert.ok(!JSON.stringify(failure).includes('private-test-value'));
  assert.ok(!('resources' in failure)); assert.ok(!('version' in failure));
  const adminState = await (await fetch(base + '/v1/admin', { headers: { authorization: auth } })).json();
  assert.match(adminState.deployments[failed.id].error, /private-test-value/);
});

test('bucket owner mismatch and changed stored bytes prevent activation', async t => {
  const { controller: c, artifact, owners, publishes } = await setup(t);
  const d = await c.submit(await artifact(), 'team-token');
  owners['slot-1'] = { app: 'someone-else' };
  await assert.rejects(c.mutate(d.id, d.digest, 'approve'), /owner mismatch/);
  assert.equal(publishes(), 0);
  delete owners['slot-1'];
  await writeFile(join(c.artifact(d.id), 'worker/index.js'), 'changed');
  await assert.rejects(c.mutate(d.id, d.digest, 'approve'), /digest mismatch/);
  assert.equal(publishes(), 0);
});

test('concurrent approvals revalidate applied SQL and pause before side effects', async t => {
  const { controller: c, artifact, backend } = await setup(t);
  const first = await c.submit(await artifact('hello', ['first']), 'team-token');
  const stale = await c.submit(await artifact('hello', ['changed']), 'team-token');
  const publish = backend.publish;
  backend.publish = async (...args) => {
    assert.equal(c.route('hello.localhost').state, 'paused');
    return publish(...args);
  };
  const results = await Promise.allSettled([c.mutate(first.id, first.digest, 'approve'), c.mutate(stale.id, stale.digest, 'approve')]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[0].value.status, 'active');
  assert.equal(results[1].status, 'rejected'); assert.match(results[1].reason.message, /not pending/);
  assert.equal(stale.status, 'superseded');
  assert.equal(c.state.apps.hello.active, first.id);
});

test('a regressed ledger cannot erase applied hashes or clear uncertain activation', async t => {
  const { controller: c, artifact, backend } = await setup(t);
  const initial = await c.submit(await artifact(), 'team-token'); await c.mutate(initial.id, initial.digest, 'approve');
  const hashes = structuredClone(c.state.apps.hello.migrations);
  const next = await c.submit(await artifact(), 'team-token');
  backend.applied = async () => [];
  let migrations = 0; backend.migrate = async () => { migrations++; };
  await c.mutate(next.id, next.digest, 'approve');
  assert.equal(next.status, 'failed'); assert.match(next.error, /Ledger lost applied migration/);
  assert.equal(migrations, 0, 'Do not replay SQL against a regressed ledger');
  assert.deepEqual(c.state.apps.hello.migrations, hashes);
  assert.equal(c.state.apps.hello.uncertain, next.id);
  assert.equal(c.route('hello.localhost').state, 'paused');
  await assert.rejects(c.mutate(next.id, next.digest, 'approve'), /Ledger lost/);
});

test('duplicate owner markers quarantine both slots without overwriting app history', async t => {
  const { controller: c, artifact, owners, backend } = await setup(t);
  const initial = await c.submit(await artifact(), 'team-token'); await c.mutate(initial.id, initial.digest, 'approve');
  const original = structuredClone(c.state.apps.hello);
  owners['slot-2'] = { app: 'hello' };
  const restarted = new Controller({ dir: c.dir, slots, backend }); await restarted.init();
  assert.equal(restarted.state.apps.hello.quarantined, true);
  assert.equal(restarted.state.apps.hello.slot, original.slot);
  assert.equal(restarted.state.apps.hello.active, original.active);
  assert.deepEqual(restarted.state.apps.hello.migrations, original.migrations);
  assert.equal(restarted.available('different'), undefined);
  const report = capacity(restarted);
  assert.equal(report.slots.available, 0);
  assert.deepEqual(report.slots.items.map(s => s.bucketOwner), ['hello', 'hello']);
  assert.equal(report.slots.items[1].assignments.length, 0);
});


test('R2 additions reserve identities before effects and survive failed activation', async t => {
  const { controller: c, artifact, backend, publishes } = await setup(t);
  const base = await artifact();
  const initial = await c.submit(base, 'team-token'); await c.mutate(initial.id, initial.digest, 'approve');
  const before = structuredClone(c.state.apps.hello.resources);
  const grown = await artifact('hello', undefined, { r2_buckets: [{ binding: 'STORAGE' }] });
  const rejected = await c.submit(grown, 'team-token');
  assert.deepEqual(rejected.resourceChanges.r2Added, [{ binding: 'STORAGE', bucket_name: 'hello-storage' }]);
  await c.mutate(rejected.id, rejected.digest, 'reject');
  assert.deepEqual(c.state.apps.hello.resources, before);
  const stale = await c.submit(base, 'team-token');
  const addition = await c.submit(grown, 'team-token');
  const ready = backend.ready;
  backend.ready = async () => {
    const disk = JSON.parse(await readFile(join(c.dir, 'state.json'), 'utf8'));
    assert.deepEqual(disk.apps.hello.resources, addition.resources);
    throw Error('Replica failed after publication');
  };
  await c.mutate(addition.id, addition.digest, 'approve');
  assert.equal(addition.status, 'failed'); assert.equal(c.route('hello.localhost').state, 'paused');
  const count = publishes();
  const restarted = new Controller({ dir: c.dir, slots, backend }); await restarted.init();
  await assert.rejects(restarted.submit(base, 'team-token'), /Resource identities changed/);
  await assert.rejects(restarted.mutate(stale.id, stale.digest, 'approve'), /Resource identities changed/);
  assert.equal(publishes(), count);
  backend.ready = ready;
  await restarted.mutate(addition.id, addition.digest, 'approve');
  assert.equal(restarted.route('hello.localhost').state, 'active');
  assert.equal(restarted.state.deployments[addition.id].resourceChanges.r2Added.length, 1);
  assert.deepEqual(restarted.state.apps.hello.resources.d1, before.d1);
  assert.deepEqual(restarted.state.apps.hello.resources.durable, before.durable);
  assert.deepEqual(restarted.state.apps.hello.resources.r2, addition.resources.r2);
});

test('failed additive migration retains reservations through rejection and corrected submission', async t => {
  const { controller: c, artifact } = await setup(t);
  const initial = await c.submit(await artifact(), 'team-token'); await c.mutate(initial.id, initial.digest, 'approve');
  const resources = { r2_buckets: [{ binding: 'STORAGE' }] };
  const failed = await c.submit(await artifact('hello', ['CREATE TABLE test (id TEXT);', 'BAD SQL'], resources), 'team-token');
  await c.mutate(failed.id, failed.digest, 'approve');
  assert.equal(failed.status, 'failed'); assert.equal(failed.step, 'migrating');
  await c.mutate(failed.id, failed.digest, 'reject');
  await assert.rejects(c.submit(await artifact(), 'team-token'), /Resource identities changed/);
  const corrected = await c.submit(await artifact('hello', ['CREATE TABLE test (id TEXT);', 'CREATE TABLE attachments (id TEXT);'], resources), 'team-token');
  assert.equal(corrected.resourceChanges.r2Added.length, 1);
  await c.mutate(corrected.id, corrected.digest, 'approve'); assert.equal(corrected.status, 'active');
});

test('private revisions are pinned, isolated, absent from artifacts, and redacted on failure', async t => {
  const { controller: c, artifact, backend, owners } = await setup(t);
  const body = await artifact('hello', undefined, { secrets: { required: ['TOKEN'] } });
  const release = await c.submit(body, 'team-token');
  await assert.rejects(c.mutate(release.id, release.digest, 'approve'), /secret revision/);
  assert.deepEqual(owners, {}); assert.equal(release.status, 'pending');
  const first = await c.replaceSecrets('hello', { TOKEN: 'private-first-value', EXTRA: 'not-injected' });
  const second = await c.replaceSecrets('hello', { TOKEN: 'private-second-value' });
  await assert.rejects(c.mutate(release.id, release.digest, 'approve', first.revision), /secret revision/);
  let observed;
  backend.publish = async (_slot, dir) => { observed = JSON.parse(await readFile(join(dir, 'wrangler.json'), 'utf8')).vars; throw Error(`provider said ${observed.TOKEN}`); };
  await c.mutate(release.id, release.digest, 'approve', second.revision);
  assert.equal(release.status, 'failed'); assert.deepEqual(observed, { TOKEN: 'private-second-value' });
  assert.ok(!JSON.stringify(c.state).includes('private-second-value'));
  assert.equal(release.secretRevision, second.revision);
  assert.deepEqual(await manifest(c.artifact(release.id), release), body);
  const rotated = await c.replaceSecrets('hello', { TOKEN: 'private-third-value' });
  await assert.rejects(c.mutate(release.id, release.digest, 'approve', rotated.revision), /pinned/);
  const restarted = new Controller({ dir: c.dir, slots, backend }); await restarted.init();
  backend.publish = async (_slot, dir) => { observed = JSON.parse(await readFile(join(dir, 'wrangler.json'), 'utf8')).vars; return 'version'; };
  await restarted.mutate(release.id, release.digest, 'approve', second.revision);
  assert.equal(restarted.state.deployments[release.id].status, 'active'); assert.equal(observed.TOKEN, 'private-second-value');
  const other = await restarted.submit(await artifact('other', undefined, { secrets: { required: ['TOKEN'] } }), 'team-token');
  await assert.rejects(restarted.mutate(other.id, other.digest, 'approve', second.revision), /secret revision/);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(c.dir, 'execution')), []);
});

test('secret updates require administrator CSRF and never return submitted values or malformed JSON', async t => {
  const { controller: c } = await setup(t);
  const http = server(c, { user: 'admin', password: 'password', deploy: 'deploy', gateway: 'gateway' });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const base = `http://127.0.0.1:${http.address().port}`;
  const auth = `Basic ${Buffer.from('admin:password').toString('base64')}`;
  const { csrf } = await (await fetch(base + '/v1/admin', { headers: { authorization: auth } })).json();
  const put = (authorization, extra = {}, data = '{"TOKEN":"private-http-value"}') => fetch(base + '/v1/apps/hello/secrets', { method: 'PUT', headers: { authorization, 'Content-Type': 'application/json', ...extra }, body: data });
  assert.equal((await put('Bearer deploy', { 'X-Fogd-CSRF': csrf })).status, 401);
  assert.equal((await put(auth)).status, 403);
  assert.equal((await put(auth, { 'X-Fogd-CSRF': csrf, Origin: 'http://evil.test' })).status, 403);
  const result = await put(auth, { 'X-Fogd-CSRF': csrf }); assert.equal(result.status, 200); assert.ok(!(await result.text()).includes('private-http-value'));
  const bad = await put(auth, { 'X-Fogd-CSRF': csrf }, '{"TOKEN":"private-http-value"'); assert.equal(bad.status, 400); assert.ok(!(await bad.text()).includes('private-http-value'));
  const state = await (await fetch(base + '/v1/admin', { headers: { authorization: auth } })).text(); assert.ok(!state.includes('private-http-value'));
});


test('approval pins private revisions before a failing slot claim and retains them across restart', async t => {
  const { controller: c, artifact, backend } = await setup(t);
  const release = await c.submit(await artifact('hello', undefined, { secrets: { required: ['TOKEN'] } }), 'team-token');
  const first = await c.replaceSecrets('hello', { TOKEN: 'private-claim-value' });
  const claim = backend.claim;
  backend.claim = async () => {
    const persisted = JSON.parse(await readFile(join(c.dir, 'state.json'), 'utf8'));
    assert.equal(persisted.deployments[release.id].secretRevision, first.revision);
    throw Error('private-claim-value');
  };
  await assert.rejects(c.mutate(release.id, release.digest, 'approve', first.revision), /diagnostics are withheld/);
  assert.equal(release.status, 'failed'); assert.equal(release.step, 'preparing-activation');
  assert.ok(!JSON.stringify(c.state).includes('private-claim-value'));
  const next = await c.replaceSecrets('hello', { TOKEN: 'private-next-value' });
  const restarted = new Controller({ dir: c.dir, slots, backend }); await restarted.init();
  await assert.rejects(restarted.mutate(release.id, release.digest, 'approve', next.revision), /pinned/);
  backend.claim = claim;
  await restarted.mutate(release.id, release.digest, 'approve', first.revision);
  assert.equal(restarted.state.deployments[release.id].status, 'active');
  const plain = await restarted.submit(await artifact('other'), 'team-token');
  await assert.rejects(restarted.mutate(plain.id, plain.digest, 'approve', next.revision), /does not declare secrets/);
});


test('submitted metadata must be canonical and cannot add hidden configuration', async t => {
  const { controller: c, artifact } = await setup(t);
  for (const metadata of [{ requiredSecrets: [] }, { requiredSecrets: ['Z', 'A'] }, { requiredSecrets: ['TOKEN'], values: { TOKEN: 'hidden-value' } }]) {
    const body = await artifact('hello', undefined, { secrets: { required: ['TOKEN'] } });
    body.files.find(file => file.path === 'fogd-deployment.json').data = Buffer.from(JSON.stringify(metadata)).toString('base64');
    await assert.rejects(c.submit(body, 'team-token'), /metadata/);
  }
});

test('scoped identities cannot cross app/status/admin boundaries and revocation survives restart', async t => {
  const { controller: c, artifact, backend } = await setup(t);
  const a = await c.issueCredential('Alice', ['hello']);
  const b = await c.issueCredential('Bob', ['other']);
  const http = server(c, { user: 'admin', password: 'password', deploy: null, gateway: 'gateway' });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const base = `http://127.0.0.1:${http.address().port}`;
  const call = (path, token, data) => fetch(base + path, { method: data ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: data ? JSON.stringify(data) : undefined });
  const body = await artifact();
  assert.equal((await call('/v1/deployments', 'deploy', body)).status, 401);
  assert.equal((await call('/v1/deployments', b.token, body)).status, 400);
  assert.equal(c.quota.used, 0); assert.equal(Object.keys(c.state.deployments).length, 0);
  const result = await call('/v1/deployments', a.token, body); assert.equal(result.status, 201);
  const release = await result.json();
  assert.equal((await call(`/v1/deployments/${release.id}`, b.token)).status, 404);
  assert.equal((await call(`/v1/deployments/${release.id}`, a.token)).status, 200);
  for (const path of ['/v1/admin', `/v1/deployments/${release.id}/artifact`]) assert.equal((await call(path, a.token)).status, 401);
  assert.equal((await call('/v1/credentials', a.token, { name: 'Escalate', apps: ['other'] })).status, 401);
  const auth = `Basic ${Buffer.from('admin:password').toString('base64')}`;
  const admin = await (await fetch(base + '/v1/admin', { headers: { authorization: auth } })).json();
  assert.ok(!JSON.stringify(admin).includes(a.token)); assert.equal(admin.credentials[0].hash, undefined);
  await c.revokeCredential(a.id);
  assert.equal((await call(`/v1/deployments/${release.id}`, a.token)).status, 401);
  const restarted = new Controller({ dir: c.dir, slots, backend }); await restarted.init();
  assert.equal(restarted.credentials.authenticate(`Bearer ${a.token}`), null);
  assert.equal(restarted.credentials.authenticate(`Bearer ${b.token}`).id, b.id);
  assert.equal(restarted.quota.used, c.quota.used);
});

test('serialized revocation and quota admission refuse queued writes without storing artifacts', async t => {
  const { controller: c, artifact, backend } = await setup(t);
  const a = await c.issueCredential('Alice', ['hello']);
  const body = await artifact();
  const revoked = c.revokeCredential(a.id);
  const queued = c.submit(body, a.id);
  await revoked; await assert.rejects(queued, /revoked/);
  assert.equal(c.quota.used, 0);
  const b = await c.issueCredential('Bob', ['hello']);
  c.maxPendingPerCredential = 1;
  const results = await Promise.allSettled([c.submit(body, b.id), c.submit(body, b.id)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /pending/);
  assert.equal(capacity(c).submissions.pending, 1);
  assert.deepEqual(capacity(c).submissions.byCredential, [{ id: b.id, pending: 1, limit: 1 }]);
  const first = results.find(r => r.status === 'fulfilled').value;
  await c.mutate(first.id, first.digest, 'reject');
  const retained = c.quota.used;
  const restarted = new Controller({ dir: c.dir, slots, backend, maxArtifactBytes: retained }); await restarted.init();
  await assert.rejects(restarted.submit(body, b.id), /capacity/);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(join(c.dir, 'artifacts')), [first.id]);
  assert.equal(restarted.quota.used, retained);
  assert.equal(capacity(restarted).artifacts.retainedArtifactBytes, retained);
  assert.equal(capacity(restarted).submissions.pending, 0);
  assert.equal((await Promise.all([c.submit(body, 'team-token'), c.submit(body, 'team-token')])).length, 2, 'Legacy token retains the global pending limit');
  c.maxPending = 2;
  await assert.rejects(c.submit(body, 'team-token'), /Pending deployment limit/);
  assert.equal(capacity(c).submissions.pending, 2);
  assert.equal(capacity(c).submissions.limit, 2);
});

test('concurrent upload cap refuses excess bodies while admitted uploads complete', async t => {
  const { controller: c, artifact } = await setup(t);
  const http = server(c, { user: 'admin', password: 'password', deploy: 'deploy', gateway: 'gateway' }, { maxUploads: 2 });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const url = `http://127.0.0.1:${http.address().port}/v1/deployments`;
  const payload = JSON.stringify(await artifact());
  const { request } = await import('node:http');
  let count = 0, both;
  const arrived = new Promise(resolve => { both = resolve; });
  http.on('request', () => { if (++count === 2) both(); });
  const slow = () => {
    let req;
    const done = new Promise((resolve, reject) => {
      req = request(url, { method: 'POST', headers: { Authorization: 'Bearer deploy', 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.write(payload.slice(0, 1));
    });
    t.after(() => req.destroy());
    return { req, done };
  };
  const a = slow(), b = slow(); await arrived;
  const excess = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer deploy', 'Content-Type': 'application/json' }, body: payload });
  assert.equal(excess.status, 429); assert.equal(Object.keys(c.state.deployments).length, 0);
  a.req.end(payload.slice(1)); b.req.end(payload.slice(1));
  assert.deepEqual(await Promise.all([a.done, b.done]), [201, 201]);
});

test('private routing listener exposes no public administration and public listener exposes no routes', async t => {
  const { controller: c } = await setup(t);
  const credentials = { user: 'admin', password: 'password', deploy: 'deploy', gateway: 'gateway' };
  const publicServer = server(c, credentials), internal = server(c, credentials, { role: 'internal' });
  for (const http of [publicServer, internal]) {
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => http.close(resolve)));
  }
  const get = (http, path, authorization) => fetch(`http://127.0.0.1:${http.address().port}${path}`, { headers: { authorization } });
  assert.equal((await get(publicServer, '/internal/route?host=hello.localhost', 'Bearer gateway')).status, 404);
  assert.equal((await get(internal, '/internal/route?host=hello.localhost', 'Bearer bad')).status, 401);
  assert.deepEqual(await (await get(internal, '/internal/route?host=hello.localhost', 'Bearer gateway')).json(), { state: 'unknown' });
  assert.equal((await get(internal, '/v1/admin', `Basic ${Buffer.from('admin:password').toString('base64')}`)).status, 404);
});

test('retired names cannot regain routes, deployments, secrets or authority after restart', async t => {
  const { retireState } = await import('../src/retirement.mjs');
  const { controller: c, artifact, backend, owners } = await setup(t);
  const token = await c.issueCredential('Original builder', ['hello']);
  const body = await artifact();
  const release = await c.submit(body, token.id); await c.mutate(release.id, release.digest, 'approve');
  const pending = await c.submit(body, token.id);
  const next = retireState(c.state, 'hello', release.digest, { previous: { slot: 'slot-1', prefix: 'one', nodes: ['a', 'b'] }, replacement: { prefix: 'new-generation', nodes: ['new-a', 'new-b'] } });
  await writeFile(join(c.dir, 'state.json'), JSON.stringify(next));
  delete owners['slot-1'];
  const replacementSlots = structuredClone(slots); replacementSlots[0].prefix = 'new-generation';
  const retired = new Controller({ dir: c.dir, slots: replacementSlots, backend }); await retired.init();
  assert.deepEqual(retired.route('hello.localhost'), { state: 'unknown' });
  assert.equal(retired.available('replacement').id, 'slot-1');
  assert.equal(capacity(retired).slots.available, 2);
  for (const submitter of [token.id, 'team-token']) await assert.rejects(retired.submit(body, submitter), /permanently retired/);
  for (const action of ['approve', 'reject']) await assert.rejects(retired.mutate(pending.id, pending.digest, action), /permanently retired/);
  await assert.rejects(retired.replaceSecrets('hello', { PRIVATE: 'new' }), /permanently retired/);
  await assert.rejects(retired.issueCredential('New authority', ['hello']), /permanently retired/);
  await assert.rejects(retired.submit(await artifact('replacement'), token.id), /scope/);
  const mismatched = new Controller({ dir: c.dir, slots, backend });
  await assert.rejects(mismatched.init(), /overlaps retired/);
  const http = server(retired, { user: 'admin', password: 'password', deploy: 'deploy', gateway: 'gateway' });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => http.close(resolve)));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const authorization = `Basic ${Buffer.from('admin:password').toString('base64')}`;
  const state = await (await fetch(origin + '/v1/admin', { headers: { authorization } })).json();
  const headers = { authorization, 'Content-Type': 'application/json', 'X-Fogd-CSRF': state.csrf };
  for (const [path, method, body] of [[`/v1/deployments/${pending.id}/approve`, 'POST', { digest: pending.digest }], ['/v1/apps/hello/secrets', 'PUT', { PRIVATE: 'blocked' }]]) {
    const response = await fetch(origin + path, { method, headers, body: JSON.stringify(body) });
    assert.equal(response.status, 400); assert.match((await response.json()).error, /permanently retired/);
  }

});
