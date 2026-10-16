import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  const artifact = async (app = 'hello', sql = ['CREATE TABLE test (id TEXT);']) => {
    const dir = join(root, `project-${sequence++}`); await mkdir(join(dir, 'dist/ssr'), { recursive: true }); await mkdir(join(dir, 'db/migrations'), { recursive: true });
    await writeFile(join(dir, 'dist/ssr/index.js'), 'export default {fetch(){return new Response("ok")}}');
    await writeFile(join(dir, 'dist/ssr/wrangler.json'), JSON.stringify({ main: 'index.js', d1_databases: [{ binding: 'DB' }] }));
    for (const [index, content] of sql.entries()) await writeFile(join(dir, 'db/migrations', `000${index + 1}_init.sql`), content);
    const outputDir = join(dir, 'artifact'); const release = await stageArtifact({ projectDir: dir, outputDir, app });
    return manifest(outputDir, release);
  };
  return { root, controller, backend, owners, artifact, publishes: () => publishes };
}

test('pending/rejected bytes never publish; exact approval activates two isolated hostnames', async t => {
  const { controller: c, artifact, publishes } = await setup(t);
  const a = await c.submit(await artifact(), 'team');
  assert.equal(c.route('hello.localhost').state, 'unknown'); assert.equal(publishes(), 0);
  await assert.rejects(c.mutate(a.id, '0'.repeat(64), 'approve'), /digest/);
  await c.mutate(a.id, a.digest, 'reject'); assert.equal(publishes(), 0);
  const b = await c.submit(await artifact(), 'team'); await c.mutate(b.id, b.digest, 'approve');
  const other = await c.submit(await artifact('second'), 'team'); await c.mutate(other.id, other.digest, 'approve');
  assert.equal(c.route('hello.localhost').state, 'active');
  assert.notEqual(c.route('hello.localhost').slot, c.route('second.localhost').slot);
  assert.equal(c.route('hello.localhost.evil').state, 'unknown');
  await assert.rejects(c.submit(await artifact('third'), 'team'), /slots/);
});

test('rejects traversal, excluded metadata, nested config, bad digest and duplicates', async t => {
  const { controller: c, artifact } = await setup(t);
  for (const path of ['../secret', 'worker/../secret', 'fogd-release.json', '/secret', 'worker\\secret']) {
    const body = await artifact(); body.files.push({ path, data: 'eA==' }); await assert.rejects(c.submit(body, 'team'), /path/);
  }
  const bad = await artifact(); bad.digest = '0'.repeat(64); await assert.rejects(c.submit(bad, 'team'), /digest/);
  const duplicate = await artifact(); duplicate.files.push(duplicate.files[0]); await assert.rejects(c.submit(duplicate, 'team'), /Duplicate/);
  const nested = await artifact(); const file = nested.files.find(f => f.path === 'wrangler.json'); const config = JSON.parse(Buffer.from(file.data, 'base64')); config.durable_objects = { bindings: [{ name: '../DB', class_name: 'Unsafe', script_name: 'other' }] }; file.data = Buffer.from(JSON.stringify(config)).toString('base64');
  await assert.rejects(c.submit(nested, 'team'), /identifier/);
});

test('partial migration failure preserves applied hashes but allows correction of unapplied SQL', async t => {
  const { controller: c, artifact } = await setup(t);
  const failed = await c.submit(await artifact('hello', ['CREATE TABLE test(id TEXT);', 'BAD SQL']), 'team');
  await c.mutate(failed.id, failed.digest, 'approve');
  assert.equal(failed.status, 'failed'); assert.equal(c.route('hello.localhost').state, 'paused');
  assert.equal(c.state.apps.hello.migrations.length, 1);
  await assert.rejects(c.submit(await artifact('hello', ['CHANGED', 'fixed']), 'team'), /Applied migration/);
  const fixed = await c.submit(await artifact('hello', ['CREATE TABLE test(id TEXT);', 'fixed']), 'team');
  await c.mutate(fixed.id, fixed.digest, 'approve'); assert.equal(fixed.status, 'active');
});

test('interruptions stay paused, require explicit retry, and reconcile attempted migrations', async t => {
  const { controller: c, artifact, backend } = await setup(t);
  const d = await c.submit(await artifact(), 'team');
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
  const d = await c.submit(await artifact(), 'team'); await c.mutate(d.id, d.digest, 'approve');
  await rm(join(c.dir, 'state.json'));
  const fresh = new Controller({ dir: c.dir, slots, backend }); await fresh.init();
  assert.equal(fresh.route('hello.localhost').state, 'paused');
  assert.equal(fresh.state.apps.hello.quarantined, true);
  assert.equal(fresh.available('different').id, 'slot-2');
  await assert.rejects(fresh.submit(await artifact(), 'team'), /quarantined/);
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
  const other = await c.submit(await artifact('other'), 'another-submitter');
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
  const d = await c.submit(await artifact(), 'team');
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
  const first = await c.submit(await artifact('hello', ['first']), 'team');
  const stale = await c.submit(await artifact('hello', ['changed']), 'team');
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
  const initial = await c.submit(await artifact(), 'team'); await c.mutate(initial.id, initial.digest, 'approve');
  const hashes = structuredClone(c.state.apps.hello.migrations);
  const next = await c.submit(await artifact(), 'team');
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
  const initial = await c.submit(await artifact(), 'team'); await c.mutate(initial.id, initial.digest, 'approve');
  const original = structuredClone(c.state.apps.hello);
  owners['slot-2'] = { app: 'hello' };
  const restarted = new Controller({ dir: c.dir, slots, backend }); await restarted.init();
  assert.equal(restarted.state.apps.hello.quarantined, true);
  assert.equal(restarted.state.apps.hello.slot, original.slot);
  assert.equal(restarted.state.apps.hello.active, original.active);
  assert.deepEqual(restarted.state.apps.hello.migrations, original.migrations);
  assert.equal(restarted.available('different'), undefined);
});
