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
  const { controller: c, artifact, publishes } = await setup(t);
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
  const path = `/v1/deployments/${d.id}/approve`;
  assert.equal((await post(path, 'Bearer deploy', { digest: d.digest })).status, 401);
  assert.equal((await post(path, auth, { digest: d.digest })).status, 403);
  const { csrf } = await (await fetch(base + '/v1/admin', { headers: { authorization: auth } })).json();
  assert.equal((await post(path, auth, { digest: d.digest }, { 'X-Fogd-CSRF': csrf, Origin: 'http://evil.test' })).status, 403);
  assert.equal(publishes(), 0);
  const result = await post(path, auth, { digest: d.digest }, { 'X-Fogd-CSRF': csrf }); assert.equal(result.status, 200); assert.equal((await result.json()).status, 'active');
});
