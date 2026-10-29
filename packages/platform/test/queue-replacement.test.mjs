import { approvalButtons } from '../src/admin-approval-controls.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { artifactDigest } from '@fogd/runtime/artifact';
import { fixture } from './fixtures/queue-controller.mjs';

const approve = (c, r, replaces, revision) => c.mutate(r.id, r.digest, 'approve', revision, replaces);
const identity = r => ({ deployment: r.id, digest: r.digest });
async function sqlRequest(f, statements, controller = f.c) {
  const request = await f.request(controller), dir = controller.artifact(request.id);
  const config = JSON.parse(await readFile(join(dir, 'wrangler.json'), 'utf8'));
  const db = { binding: 'DB', database_name: 'imports-db', database_id: 'imports-db', migrations_dir: 'migrations/DB' };
  config.d1_databases = [db]; request.resources.d1 = [db];
  await writeFile(join(dir, 'wrangler.json'), JSON.stringify(config));
  await mkdir(join(dir, db.migrations_dir), { recursive: true });
  request.migrations = [];
  for (const [index, sql] of statements.entries()) {
    const name = `000${index + 1}_migration.sql`;
    await writeFile(join(dir, db.migrations_dir, name), sql);
    request.migrations.push({ database: db.database_id, name, digest: createHash('sha256').update(sql).digest('hex') });
  }
  request.digest = await artifactDigest(dir); await controller.save(); return request;
}
async function failedMigration(t) {
  const f = await fixture(t), applied = [];
  f.backend.applied = async () => { assert.equal(f.paused(), true); return structuredClone(applied); };
  f.backend.migrate = async (_, dir, resources) => {
    assert.equal(f.paused(), true);
    const db = resources.d1[0];
    for (const name of ['0001_migration.sql', '0002_migration.sql']) {
      if (applied.some(row => row.name === name)) continue;
      const sql = await readFile(join(dir, db.migrations_dir, name), 'utf8');
      if (sql === 'BAD SQL') throw Error('Invalid migration');
      applied.push({ database: db.database_id, name });
    }
  };
  const old = await sqlRequest(f, ['CREATE first', 'BAD SQL']);
  await approve(f.c, old); assert.equal(old.status, 'failed');
  assert.equal(f.c.state.apps.imports.uncertain, old.id);
  assert.equal(f.c.state.apps.imports.migrations.length, 0, 'failed queue activation defers reconciliation');
  return { ...f, old, applied };
}

test('replacement reconciles original partial migration before transferring hold and publishing corrected code', async t => {
  const f = await failedMigration(t), next = await sqlRequest(f, ['CREATE first', 'CREATE second']);
  await assert.rejects(approve(f.c, next), /held queue activation/);
  await approve(f.c, next, identity(f.old));
  assert.equal(next.status, 'active'); assert.deepEqual(next.replaces, identity(f.old));
  assert.equal(f.c.state.apps.imports.migrations.length, 2);
  assert.equal(f.c.state.apps.imports.uncertain, null);
  assert.equal(f.c.state.apps.imports.delivery.hold, null);
  assert.equal(f.old.status, 'superseded');
  assert.equal(f.events.filter(event => event === 'bootstrap').length, 1);
});

test('replacement rejects changes to newly discovered applied SQL and retains the original hold', async t => {
  const f = await failedMigration(t), next = await sqlRequest(f, ['CHANGED first', 'CREATE second']);
  await assert.rejects(approve(f.c, next, identity(f.old)), /Applied migration changed/);
  assert.equal(f.c.state.apps.imports.delivery.hold, f.old.id);
  assert.equal(f.c.state.apps.imports.migrations.length, 1);
  assert.equal(next.status, 'pending'); assert.equal(f.paused(), true);
  assert.equal(f.events.includes('publish'), false);
});

test('replacement identity, resource, and artifact mismatches refuse before transferring the hold', async t => {
  const f = await failedMigration(t), next = await sqlRequest(f, ['CREATE first', 'CREATE second']);
  await assert.rejects(approve(f.c, next, { ...identity(f.old), digest: 'b'.repeat(64) }), /Held deployment\/digest/);
  next.resources.queues = { ...next.resources.queues, consumers: [{ queue: 'other' }] };
  await assert.rejects(approve(f.c, next, identity(f.old)), /Resource identities changed/);
  next.resources.queues = f.old.resources.queues;
  await writeFile(join(f.c.artifact(f.old.id), 'worker/index.js'), 'changed');
  await assert.rejects(approve(f.c, next, identity(f.old)), /Original held artifact digest/);
  assert.equal(f.c.state.apps.imports.delivery.hold, f.old.id);
});

test('replacement retains operator pause and can retry after an uncertain transfer pause', async t => {
  const f = await failedMigration(t), next = await sqlRequest(f, ['CREATE first', 'CREATE second']);
  f.c.state.apps.imports.delivery.desired = 'paused'; await f.c.save();
  const pause = f.backend.queues.pause; let count = 0;
  f.backend.queues.pause = async (...args) => { const result = await pause(...args); if (++count === 2) throw Error('Lost transfer pause response'); return result; };
  await assert.rejects(approve(f.c, next, identity(f.old)), /Lost transfer pause/);
  assert.equal(next.status, 'failed'); assert.equal(f.c.state.apps.imports.delivery.hold, next.id);
  assert.equal(f.c.state.apps.imports.delivery.version, null);
  const restarted = f.create(); await restarted.init();
  await approve(restarted, restarted.state.deployments[next.id], identity(f.old));
  assert.equal(restarted.state.deployments[next.id].status, 'active');
  assert.equal(f.paused(), true); assert.equal(restarted.state.apps.imports.delivery.desired, 'paused');
});

test('ambiguous transfer persistence reloads either the original hold or the fully approved replacement', async t => {
  for (const side of ['before', 'after']) await t.test(side, async t => {
    const f = await failedMigration(t), next = await sqlRequest(f, ['CREATE first', 'CREATE second']);
    f.failWrite(state => state.deployments?.[next.id]?.step === 'transferring-delivery-hold' ? side : null);
    await assert.rejects(approve(f.c, next, identity(f.old)), { code: 'CONTROLLER_STORAGE_UNCERTAIN' });
    f.failWrite(null); const c = f.create(); await c.init();
    assert.equal(c.state.apps.imports.delivery.hold, side === 'before' ? f.old.id : next.id);
    assert.equal(c.state.deployments[next.id].status, side === 'before' ? 'pending' : 'failed');
    assert.equal(c.state.apps.imports.uncertain, null);
    await approve(c, c.state.deployments[next.id], identity(f.old));
    assert.equal(c.state.deployments[next.id].status, 'active');
  });
});

test('failed preflight preserves the original failure step and error', async t => {
  const f = await failedMigration(t), next = await sqlRequest(f, ['CHANGED first', 'CREATE second']);
  const before = { step: f.old.step, error: f.old.error };
  await assert.rejects(approve(f.c, next, identity(f.old)), /Applied migration/);
  assert.deepEqual({ step: f.old.step, error: f.old.error }, before);
});

test('a pre-intent transfer failure restores candidate metadata before another save', async t => {
  const { Delivery } = await import('../src/delivery.mjs');
  const f = await failedMigration(t), next = await sqlRequest(f, ['CREATE first', 'CREATE second']);
  next.requiredSecrets = ['SECRET'];
  const revision = (await f.c.replaceSecrets('imports', { SECRET: 'private-value' })).revision;
  const original = structuredClone(next), hold = Delivery.prototype.hold;
  Delivery.prototype.hold = function(id, options) { if (id === next.id) throw Error('Before transfer intent'); return hold.call(this, id, options); };
  try { await assert.rejects(approve(f.c, next, identity(f.old), revision), /Private replacement/); }
  finally { Delivery.prototype.hold = hold; }
  assert.deepEqual(next, original); assert.equal(f.c.state.apps.imports.privateConfiguration, false); await f.c.save();
  const c = f.create(); await c.init();
  assert.equal(c.state.apps.imports.delivery.hold, f.old.id);
  assert.equal(c.state.deployments[next.id].status, 'pending');
});

test('startup refuses a conflicting activating record instead of stealing its existing hold', async t => {
  const f = await failedMigration(t), next = await sqlRequest(f, ['CREATE first', 'CREATE second']);
  next.status = 'activating'; await f.c.save();
  await assert.rejects(f.create().init(), /conflicts with another delivery hold/);
});

test('migration coordinator never overwrites evidence for another uncertain attempt', async t => {
  const f = await failedMigration(t), next = await sqlRequest(f, ['CREATE first', 'CREATE second']);
  // Inject an inconsistent future caller's state to test the central backstop.
  f.c.state.apps.imports.delivery.hold = next.id; next.status = 'failed';
  await approve(f.c, next);
  assert.equal(next.status, 'failed'); assert.match(next.error, /original migration attempt/);
  assert.equal(f.c.state.apps.imports.uncertain, f.old.id);
});

test('SIGKILL around replacement transfer retains one approved hold owner and never reboots app code', async t => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { Controller } = await import('../src/controller.mjs');
  const { queueBackend } = await import('./fixtures/queue-backend.mjs');
  const { slots } = await import('./fixtures/queue-controller.mjs');
  const { readJson } = await import('../src/store.mjs');
  for (const point of ['before', 'intent', 'effect', 'confirmed']) await t.test(point, async t => {
    const f = await fixture(t); let failPublish = true;
    f.c.backend = queueBackend(f.c.dir, event => { if (event === 'publish' && failPublish) { failPublish = false; throw Error('Lost first publish'); } });
    const old = await f.request(); await approve(f.c, old); assert.equal(old.status, 'failed');
    const next = await f.request();
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/queue-replacement-crash.mjs', import.meta.url)), f.c.dir, next.id, old.id, old.digest, point], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const runtime = await readJson(join(f.c.dir, 'queue-runtime.json'));
    const c = new Controller({ queueApps: true, dir: f.c.dir, slots, backend: queueBackend(f.c.dir) }); await c.init();
    assert.equal(c.state.apps.imports.delivery.hold, point === 'before' ? old.id : next.id);
    assert.equal(c.state.deployments[next.id].status, point === 'before' ? 'pending' : 'failed');
    assert.equal((await readJson(join(f.c.dir, 'queue-runtime.json'))).paused, true);
    await approve(c, c.state.deployments[next.id], identity(old));
    assert.equal(c.state.deployments[next.id].status, 'active');
    const after = await readJson(join(f.c.dir, 'queue-runtime.json'));
    assert.equal(after.events.slice(runtime.events.length).includes('bootstrap'), false);
  });
});

test('HTTP and CLI replacement approval bind both digests and preserve the admin boundary', async t => {
  const { server } = await import('../src/http.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const f = await failedMigration(t), next = await sqlRequest(f, ['CREATE first', 'CREATE second']);
  const http = server(f.c, { user: 'admin', password: 'password', deploy: 'deploy', gateway: 'gateway' });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => http.close(resolve)));
  const origin = `http://127.0.0.1:${http.address().port}`, auth = { authorization: `Basic ${Buffer.from('admin:password').toString('base64')}` };
  const { csrf } = await (await fetch(origin + '/v1/admin', { headers: auth })).json();
  // This private activation fixture bypasses artifact canonicalization.
  assert.equal((await fetch(origin + '/admin/review/' + next.id, { headers: auth })).status, 409);
  const page = approvalButtons(f.c, next, '0'.repeat(64));
  assert.ok(page.includes(`data-replaces="${f.old.id}"`)); assert.ok(page.includes('Approve replacement'));
  next.replaces = { deployment: 'earlier', digest: '0'.repeat(64) };
  const stale = approvalButtons(f.c, next, '0'.repeat(64));
  assert.equal(stale.includes(`data-id="${next.id}" data-digest="${next.digest}" data-action="approve"`), false);
  assert.ok(stale.includes('Resubmit the artifact')); delete next.replaces;
  const post = (replaces, extra = {}) => fetch(`${origin}/v1/deployments/${next.id}/approve`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'X-Fogd-CSRF': csrf, ...extra }, body: JSON.stringify({ digest: next.digest, replaces }) });
  assert.equal((await post(identity(f.old), { authorization: 'Bearer deploy' })).status, 401);
  assert.equal((await post(identity(f.old), { 'X-Fogd-CSRF': '' })).status, 403);
  assert.equal((await post({ ...identity(f.old), digest: 'c'.repeat(64) })).status, 400);
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../../cli/bin/fogd.js', import.meta.url)), 'admin', 'repair', next.id, next.digest, f.old.id, f.old.digest], {
    env: { ...process.env, FOGD_ENV_FILE: join(f.c.dir, 'absent.env'), FOGD_SERVER: origin, FOGD_ADMIN_USER: 'admin', FOGD_ADMIN_PASSWORD: 'password' }, timeout: 15000,
  });
  const result = JSON.parse(stdout); assert.equal(result.status, 'active'); assert.deepEqual(result.replaces, identity(f.old));
});

test('replacement pins its selected secret revision atomically and retry cannot adopt a rotation', async t => {
  const f = await failedMigration(t), next = await sqlRequest(f, ['CREATE first', 'CREATE second']);
  next.requiredSecrets = ['SECRET']; f.backend.applicationReady = async () => {};
  const revision = (await f.c.replaceSecrets('imports', { SECRET: 'first-private-value' })).revision;
  const pause = f.backend.queues.pause; let count = 0;
  f.backend.queues.pause = async (...args) => { const result = await pause(...args); if (++count === 2) throw Error('first-private-value'); return result; };
  await assert.rejects(approve(f.c, next, identity(f.old), revision), /Private replacement/);
  assert.equal(next.secretRevision, revision); assert.equal(next.error.includes('first-private-value'), false);
  const rotated = (await f.c.replaceSecrets('imports', { SECRET: 'second-private-value' })).revision;
  await assert.rejects(approve(f.c, next, identity(f.old), rotated), /pinned revision/);
  const publish = f.backend.publish;
  f.backend.publish = async (slot, dir) => { assert.equal(JSON.parse(await readFile(join(dir, 'wrangler.json'), 'utf8')).vars.SECRET, 'first-private-value'); return publish(slot, dir); };
  await approve(f.c, next, identity(f.old), revision);
  assert.equal(next.status, 'active'); assert.equal(next.secretRevision, revision);
});

test('a failed preflight does not pin candidate secrets or discard the original diagnostics', async t => {
  const f = await failedMigration(t), next = await sqlRequest(f, ['CHANGED first', 'CREATE second']);
  next.requiredSecrets = ['SECRET']; const oldError = f.old.error;
  const revision = (await f.c.replaceSecrets('imports', { SECRET: 'private-value' })).revision;
  await assert.rejects(approve(f.c, next, identity(f.old), revision), /Private replacement/);
  assert.equal(next.secretRevision, undefined); assert.equal(f.old.error, oldError);
  assert.equal(f.c.state.apps.imports.delivery.hold, f.old.id);
});

test('replacement before bootstrap completion establishes the original producer-only gate', async t => {
  const f = await fixture(t), old = await f.request(); f.fail('bootstrap');
  await approve(f.c, old); assert.equal(old.status, 'failed');
  const next = await f.request(); await approve(f.c, next, identity(old));
  assert.equal(next.status, 'active'); assert.equal(f.events.filter(event => event === 'bootstrap').length, 2);
  assert.equal(f.events.filter(event => event === 'publish').length, 1);
});

test('after reconciled transfer the old request can be rejected without deleting its artifact', async t => {
  const f = await failedMigration(t), next = await sqlRequest(f, ['CREATE first', 'CREATE second']);
  const pause = f.backend.queues.pause; let count = 0;
  f.backend.queues.pause = async (...args) => { const result = await pause(...args); if (++count === 2) throw Error('Lost transfer pause'); return result; };
  await assert.rejects(approve(f.c, next, identity(f.old)), /Lost transfer pause/);
  await f.c.mutate(f.old.id, f.old.digest, 'reject');
  assert.equal(f.old.status, 'rejected'); assert.equal(await artifactDigest(f.c.artifact(f.old.id)), f.old.digest);
  await approve(f.c, next);
  assert.equal(next.status, 'active'); assert.equal(f.old.status, 'rejected');
});

test('startup diagnoses an uncertain attempt that is not the held activation', async t => {
  const f = await failedMigration(t); f.c.state.apps.imports.uncertain = 'different-attempt'; await f.c.save();
  await assert.rejects(f.create().init(), /Uncertain migration different-attempt conflicts/);
});

test('SIGKILL after preflight reconciliation retains old hold and newly learned migration hashes', async t => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { saveJson, readJson } = await import('../src/store.mjs');
  const f = await failedMigration(t), next = await sqlRequest(f, ['CREATE first', 'CREATE second']);
  await saveJson(join(f.c.dir, 'owner-one.json'), { app: 'imports' });
  await saveJson(join(f.c.dir, 'queue-runtime.json'), { version: 'bootstrap', paused: true, events: [] });
  await saveJson(join(f.c.dir, 'applied.json'), f.applied);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/queue-replacement-crash.mjs', import.meta.url)), f.c.dir, next.id, f.old.id, f.old.digest, 'reconciled'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const state = await readJson(join(f.c.dir, 'state.json'));
  assert.equal(state.apps.imports.delivery.hold, f.old.id); assert.equal(state.apps.imports.uncertain, null);
  assert.deepEqual(state.apps.imports.migrations, [f.old.migrations[0]]);
  assert.equal(state.deployments[next.id].status, 'pending');
  const c = f.create(); await c.init(); await approve(c, c.state.deployments[next.id], identity(f.old));
  assert.equal(c.state.deployments[next.id].status, 'active');
});
